// netlify/functions/process-email-queue.js
import { v2 as cloudinary } from 'cloudinary';
import { SAFMA_LOGO_BASE64, SAFMA_FOOTER_BASE64 } from './staticAssets';
const admin = require('firebase-admin');

// Initialize Firebase ONCE
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

// Initialize Cloudinary (Ensure these are in your Netlify Environment Variables!)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const delay = async (ms) => {
    new Promise(resolve => setTimeout(resolve, ms));
};

const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.MAILEROO_API_KEY
};

// 🛡️ THE CLEANUP PROTOCOL
const deleteCloudinaryAttachments = async (campaignData) => {

    console.log("Queue triggered, but recipient list is empty. Initiating cleanup...");

    // 1. Delete orphaned files from Cloudinary
    if (campaignData.attachments && campaignData.attachments.length > 0) {
        await Promise.all(campaignData.attachments.map(async (att) => {
            // Ignore the hardcoded local base64 images
            if (att.contentBase64) return;

            // Cloudinary requires the 'public_id' to delete a file, not the URL.
            // If you saved 'public_id' from the frontend upload, we use that!
            const publicId = att.public_id; 

            if (publicId) {
                try {
                    await cloudinary.uploader.destroy(publicId);
                    console.log(`Successfully wiped orphaned file: ${publicId}`);
                } catch (error) {
                    console.error(`Failed to delete file ${publicId} from Cloudinary:`, error);
                }
            } else {
                console.warn("Could not delete file: No public_id found in attachment payload.");
            }
        }));
    }

    console.log("Cleanup complete. Queue safely aborted.");
    
    // 3. Kill the function early so Maileroo never gets called!
    return {
        statusCode: 200,
        body: "Aborted: No attachments. Cleanup successful."
    };
}


const handler = async function(event, context) {

    console.log("Waking up to process the email queue...");

    try {
        

        try {
            const db = admin.firestore();
            const now = new Date();

            // ==========================================
            // 🛑 NEW: MASTER PAUSE SWITCH 
            // Check if Maileroo is busy with a native queue
            // ==========================================
            const stateRef = db.collection('utils').doc('queueState');
            const stateSnap = await stateRef.get();

            const snapshot = await db.collection("mailerooPayloads")
                .orderBy("createdAt", "asc")
                .limit(1)
                .get()
    
            if (snapshot.empty) {
                console.log("💤 No campaigns are ready to be processed. Going back to sleep.");
                return new Response("No campaigns are ready to be processed. Going back to sleep.", { status: 200 });
            }
    
            const campaignDoc = snapshot.docs[0];
            const campaignData = campaignDoc.data();
            const campaignRef = campaignDoc.ref;
            const recipients = campaignData.recipients || [];
    
            // Safety catch: If array is empty, delete the document
            if (recipients.length === 0) {
                await campaignRef.delete();
                return new Response("Array is empty", { status: 200 });
            }
    
            // 3. Slice off exactly 30 emails for this hour's batch
            //const batch = recipients.slice(0, 30);
            //const remainingRecipients = recipients.slice(30);
            const batch = recipients.slice(0, 1);
            const remainingRecipients = recipients.slice(1);
    
            console.log(`📤 Sending ${batch.length} emails. ${remainingRecipients.length} left in queue.`);



            // 4. Download dynamic attachments from Cloudinary & convert back to Base64
            const processedAttachments = await Promise.all(
                (campaignData.attachments || []).map(async (att) => {
                    
                    // 🛡️ Guard 1: Skip inline Base64 files completely. 
                    // We handle the Logo and Footer locally in step 6!
                    if (att.contentBase64) return null; 

                    // 🛡️ Guard 2: Grab the Cloudinary URL
                    const targetUrl = att.url || att.secure_url;
                    if (!targetUrl) return null;

                    const response = await fetch(targetUrl);

                    // 🛡️ Guard 3: Stop the silent 404 HTML bug!
                    if (!response.ok) {
                        console.error("Cloudinary failed to serve the file:", targetUrl);
                        throw new Error(`Failed to fetch attachment. Status: ${response.status}`);
                    }

                    const arrayBuffer = await response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    
                    return {
                        file_name: att.fileName || att.original_filename || "attachment.png", 
                        content: buffer.toString('base64')
                    };
                })
            );

            // 5. Filter out any of the 'null' values we skipped in Guard 1
            const finalAttachments = processedAttachments.filter(att => att !== null);

            // 6. Inject the Local Static Assets as INLINE attachments for Maileroo
            finalAttachments.push(
                {
                    file_name: "safma-logo.png",
                    content: SAFMA_LOGO_BASE64,
                    inline: true,
                },
                {
                    file_name: "confidential.png",
                    content: SAFMA_FOOTER_BASE64,
                    inline: true,
                }
            );

            // Now pass `finalAttachments` into your mailerooPayload!

            // 7. Send to Maileroo via their REST API (IN PARALLEL)
            // Promise.all fires every request simultaneously. 30 requests will finish in ~300ms total!

            await Promise.all(
                batch.map(async (email) => {
                    const mailerooPayload = {
                        from: { 
                            address: campaignData.fromEmail, 
                            display_name: campaignData.fromName 
                        },
                        to: [{ 
                            address: email, 
                            display_name: "Recipient" 
                        }], 
                        subject: campaignData.subject,
                        html: campaignData.html,
                        plain: campaignData.plain,
                        attachments: finalAttachments
                    };

                    const response = await fetch('https://smtp.maileroo.com/api/v2/emails', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-API-Key': process.env.MAILEROO_API_KEY
                        },
                        body: JSON.stringify(mailerooPayload)
                    });

                    // Optional: Catch individual failures without crashing the whole batch
                    if (!response.ok) {
                        const errText = await response.text();
                        console.error(`❌ Maileroo failed to send to ${email}:`, errText);
                    }
                })
            );

    
            // 6. Update or Delete the Firebase queue
            if (remainingRecipients.length === 0) {

                console.log("✅ Campaign completely finished! Deleting from Firestore.");

                // 1. Prepare your concurrent cleanup array
                const cleanupTasks = [
                    deleteCloudinaryAttachments(campaignData),
                    campaignDoc.ref.delete() // Destroy the finished queue payload
                ];

                console.log("Remaining recipients: " + remainingRecipients.length);

                const historyId = campaignData.historyId || null;

                if (historyId) {

                    const historyRef = db.collection("history").doc(historyId);

                    await historyRef.update({
                        status: "completed",
                        completedAt: admin.firestore.FieldValue.serverTimestamp() // Native backend timestamp
                    }, { merge: true });

                }

                // 3. Check if there are other campaigns waiting in line
                const remainingQueueSnapshot = await db.collection("mailerooPayloads")
                    .where(admin.firestore.FieldPath.documentId(), "!=", campaignDoc.id)
                    .limit(1)
                    .get();

                if (remainingQueueSnapshot.empty) {
                    // Queue is completely empty! Safe to do a master reset.
                    console.log("✨ Deep queue is empty. Resetting master state.");
                    cleanupTasks.push(stateRef.update({
                        activeScheduledCount: 0,
                        lastScheduledDate: null
                    }));
                } else {
                    // Other campaigns are waiting! Just decrement the batch size we just sent.
                    console.log("⏳ Other campaigns detected in queue. Decrementing active count safely.");
                    cleanupTasks.push(stateRef.update({
                        // Subtracts exactly this batch's size from the global counter
                        activeScheduledCount: admin.firestore.FieldValue.increment(-remainingRecipients.length)
                    }));
                }

                // 4. Fire everything off simultaneously!
                await Promise.all(cleanupTasks);

            } else {

                console.log(`⏳ Updating queue. Next batch will send in 10 minutes.`);
                

                await Promise.all([

                    campaignDoc.ref.update({
                        recipients: remainingRecipients,
                    }),

                    stateRef.update({
                        activeScheduledCount: admin.firestore.FieldValue.increment(-remainingRecipients.length)
                    }),

                ])

            }
    
            return new Response("Batch processed successfully", { status: 200 });
    
        } catch (error) {
            console.error("🚨 Queue processing failed:", error);
            return new Response("Internal server error", { status: 500 });
        }

    } catch (error) {
        console.error("Queue processing failed:", error);
        return new Response("Internal server error", { status: 500 });
    }
};


// This tells Netlify to run this function at the top of every second hour
export const config = {
    schedule: "*/5 * * * *" 
};

export default handler;
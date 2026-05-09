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
        // 1. Connect to your free Firebase database

        // 2. Fetch the campaign and the next 30 emails

        // 3. Download the attachment from Cloud Storage

        // 4. Send the 30 emails via the Maileroo API

        // 5. Delete those 30 emails from the Firebase queue
        
        // If the queue is now empty, delete the file from Cloud Storage

        try {
            const db = admin.firestore();
            const now = new Date();

            // ==========================================
            // 🛑 NEW: MASTER PAUSE SWITCH 
            // Check if Maileroo is busy with a native queue
            // ==========================================
            const stateRef = db.collection('utils').doc('queueState');
            const stateSnap = await stateRef.get();
            
            if (stateSnap.exists) {
                const stateData = stateSnap.data();
                // Convert Firestore Timestamp to JS Date
                const lastScheduledDate = stateData.lastScheduledDate?.toDate(); 
                
                if (lastScheduledDate && now < lastScheduledDate) {
                    console.log(`⏸️ Native queue is busy until ${lastScheduledDate}. Netlify is going back to sleep.`);
                    return new Response(`⏸️ Native queue is busy until ${lastScheduledDate}. Netlify is going back to sleep.`, { statusCode: 200 });
                }
            }
    
            // 2. Fetch the oldest campaign that is ready to be processed 
            const campaignsRef = db.collection("utils");
            const snapshot = await campaignsRef
                .where('status', '==', 'queued')
                .where('processAfter', '<=', now.toISOString())
                .orderBy('processAfter', 'asc')
                .limit(1)
                .get();
    
            if (snapshot.empty) {
                console.log("💤 No campaigns are ready to be processed. Going back to sleep.");
                return new Response("No campaigns are ready to be processed. Going back to sleep.", { status: 200 });
            }
    
            const campaignDoc = snapshot.docs[0];
            const campaignData = campaignDoc.data();
            const recipients = campaignData.recipients || [];
    
            // Safety catch: If array is empty, delete the document
            if (recipients.length === 0) {
                await campaignDoc.ref.delete();
                return new Response("Array is empty", { status: 200 });
            }
    
            // 3. Slice off exactly 30 emails for this hour's batch
            //const batch = recipients.slice(0, 30);
            //const remainingRecipients = recipients.slice(30);
            const batch = recipients.slice(0, 1);
            const remainingRecipients = recipients.slice(1);
    
            console.log(`📤 Sending ${batch.length} emails. ${remainingRecipients.length} left in queue.`);
    
            // 4. Download attachments from Cloudinary & convert back to Base64 for Maileroo
            /*
            const processedAttachments = await Promise.all(
                (campaignData.attachments || []).map(async (att) => {
                    const response = await fetch(att.url);
                    const arrayBuffer = await response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    
                    return {
                        file_name: att.fileName,            // 👈 Changed to file_name
                        content_type: att.contentType,      // 👈 Added to be safe
                        content: buffer.toString('base64'), // Maileroo needs this!
                        inline: att.inline ? true : false   // 👈 Changed from disposition string to boolean
                        // ❌ content_id is completely removed!
                    };
                })
            );
            */

            // 4. Download attachments from Cloudinary & convert back to Base64 for Maileroo
            /*
            const processedAttachments = await Promise.all(
                (campaignData.attachments || []).map(async (att) => {
                    
                    // 🛡️ Guard 1: If it's your Logo or Footer (already Base64), skip the download entirely!
                    if (att.contentBase64) {
                        return {
                            filename: att.fileName || "image.png", // Maileroo strictly requires 'filename'
                            content: att.contentBase64
                        };
                    }

                    // 🛡️ Guard 2: Grab the Cloudinary URL (sometimes it's saved as secure_url)
                    const targetUrl = att.url || att.secure_url;
                    const response = await fetch(targetUrl);

                    // 🛡️ Guard 3: Stop the silent 404 HTML bug!
                    if (!response.ok) {
                        console.error("Cloudinary failed to serve the file:", targetUrl);
                        throw new Error(`Failed to fetch attachment. Status: ${response.status}`);
                    }

                    const arrayBuffer = await response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    
                    return {
                        // Cloudinary sometimes renames 'fileName' to 'original_filename', so we check both
                        filename: att.fileName || att.original_filename || "attachment.png", 
                        content: buffer.toString('base64')
                        
                        // Note: Maileroo's basic v2 REST endpoint usually ignores 'inline' and 'content_type', 
                        // but keeping them removed keeps the payload safely inside their strict schema!
                    };
                })
            );
            */


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
                        filename: att.fileName || att.original_filename || "attachment.png", 
                        content: buffer.toString('base64')
                    };
                })
            );

            // 5. Filter out any of the 'null' values we skipped in Guard 1
            const finalAttachments = processedAttachments.filter(att => att !== null);

            // 6. Inject the Local Static Assets as INLINE attachments for Maileroo
            finalAttachments.push(
                {
                    filename: "safma-logo.png",
                    content: SAFMA_LOGO_BASE64,
                    inline: true,
                    content_id: "safma-logo.png" // 👈 This strictly links to src="cid:safma-logo.png" in your HTML!
                },
                {
                    filename: "confidential.png",
                    content: SAFMA_FOOTER_BASE64,
                    inline: true,
                    content_id: "confidential.png" // 👈 This strictly links to src="cid:confidential.png" in your HTML!
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
    
            // 5. Send to Maileroo via their REST API
            /*
            for (const email of batch) {
                const mailerooPayload = {
                    from: { 
                        address: campaignData.fromEmail, 
                        display_name: campaignData.fromName },
                    to: [{ 
                        address: email, 
                        display_name: "Recipient" 
                    }], 
                    subject: campaignData.subject,
                    html: campaignData.html,
                    plain: campaignData.plain,
                    attachments: processedAttachments,
                    //headers: headers
                };
    
                const response = await fetch('https://smtp.maileroo.com/api/v2/emails', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': process.env.MAILEROO_API_KEY
                    },
                    body: JSON.stringify(mailerooPayload)
                });
    
                if (!response.ok) {
                    const errText = await response.text();
                    console.error(`❌ Maileroo failed to send to ${email}:`, errText);
                }

                await delay(500);

            }
            */

    
            // 6. Update or Delete the Firebase queue
            if (remainingRecipients.length === 0) {

                console.log("✅ Campaign completely finished! Deleting from Firestore.");
                await deleteCloudinaryAttachments(campaignData);
                await campaignDoc.ref.delete();

            } else {

                console.log(`⏳ Updating queue. Next batch will send in 1 hour.`);
                await campaignDoc.ref.update({
                    recipients: remainingRecipients,
                });

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
    schedule: "*/10 * * * *" 
};

export default handler;

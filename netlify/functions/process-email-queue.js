// netlify/functions/process-email-queue.js
import { schedule } from '@netlify/functions';
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

const delay = async (ms) => {
    new Promise(resolve => setTimeout(resolve, ms));
};

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
            const batch = recipients.slice(0, 30);
            const remainingRecipients = recipients.slice(30);
    
            console.log(`📤 Sending ${batch.length} emails. ${remainingRecipients.length} left in queue.`);
    
            // 4. Download attachments from Cloudinary & convert back to Base64 for Maileroo
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
    
            // 5. Send to Maileroo via their REST API
            for (const email of batch) {
                const mailerooPayload = {
                    from: { email: campaignData.fromEmail, name: campaignData.fromName },
                    to: [{ email: email, name: "Recipient" }], 
                    subject: campaignData.subject,
                    html: campaignData.html,
                    plain: campaignData.plain,
                    attachments: processedAttachments
                };
    
                const response = await fetch('https://api.maileroo.com/send', {
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
    
            // 6. Update or Delete the Firebase queue
            if (remainingRecipients.length === 0) {
                console.log("✅ Campaign completely finished! Deleting from Firestore.");
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

/*
// This tells Netlify to run this function at the top of every second hour
export const config = {
    schedule: "0 7,9,11,13 * * 1-5" 
};

export default schedule("0 7,9,11,13 * * 1-5", handler);
*/

// Temporarily run EVERY MINUTE for testing
export const config = {
    schedule: "*/2 * * * *" 
};

export default schedule("*/2 * * * *", handler);
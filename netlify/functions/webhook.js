const admin = require('firebase-admin');
const crypto = require('crypto');

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

const db = admin.firestore(); // or admin.database() for Realtime DB

// Optional: Verify Maileroo signature
function verifySignature(req) {

  const secret = process.env.MAILEROO_SECRET;

  const signature = req.headers['x-maileroo-signature']; // replace with actual Maileroo header if different
  
  const payload = req.body;

  if (!signature || !secret) return false;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const digest = hmac.digest('hex');

  return signature === digest;
}

// Webhook endpoint
exports.handler = async (event, context) => {

  try {

    // Only allow POST
    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            body: "Method Not Allowed",
        };
    }

    // ==========================================
    // 🔐 2. VERIFY THE SIGNATURE HERE
    // Pass the entire 'event' object as the parameter
    // ==========================================
    if (!verifySignature(event)) {
        console.error("🚨 Unauthorized Webhook Attempt: Invalid Signature");
        return {
            statusCode: 401,
            body: JSON.stringify({ error: "Unauthorized" }),
        };
    }

    const data = JSON.parse(event.body);

    // 🔐 OPTIONAL: Verify Maileroo signature (add later if needed)
    // const signature = event.headers["x-maileroo-signature"];

    // Extract key info (adjust depending on Maileroo payload)
    const email = data?.event_data?.to || "unknown";
    const status = data?.event_type || "unknown";
    const subject = data?.tags?.[0] || "unknown subject"
    const timestamp = new Date().toISOString();
    const messageId = data?.message_reference_id || 
                  (data?.message_id ? data?.message_id.replace(/[<>]/g, "") : null) || 
                  Date.now().toString();
    

    // Store EVERYTHING (raw + structured)
    await db.collection("emailEvents").add({
      email,
      status,
      timestamp,
      raw: data,
    });

    if (["deferred", "rejected", "failed", "complained", "bounced"].includes(status)) {

      try {

        // Store IMPORTANT email data (raw + structured)
        await db.collection("notifications").doc(messageId).set({
          email,
          status,
          subject,
          timestamp,
          isRead: false,
          raw: data,
          updatedAt: timestamp
        }, { merge: true });
        console.log("Successfully added important notifications");

      } catch (error) {

        return {
          statusCode: 500,
          body: JSON.stringify({ 
            error: "Data could not be saved to database",
            errorMessage: error.message
         }),
        };

      }
    }

    // ⚡ Respond FAST (important for webhook reliability)
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true }),
    };

  } catch (error) {

    console.error("Webhook error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: "Internal Server Error",
        errorMessage: error.message
     }),
    };


  }
};

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

const db = admin.firestore(); // or admin.database() for Realtime DB

// Optional: Verify Maileroo signature
function verifySignature(req) {
  const secret = process.env.MAILEROO_SECRET;
  const signature = req.headers['x-maileroo-signature']; // replace with actual Maileroo header if different
  const payload = JSON.stringify(req.body);

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

    const data = JSON.parse(event.body);

    // 🔐 OPTIONAL: Verify Maileroo signature (add later if needed)
    // const signature = event.headers["x-maileroo-signature"];

    // Extract key info (adjust depending on Maileroo payload)
    const email = data?.recipient || "unknown";
    const status = data?.event || "unknown";
    const timestamp = new Date().toISOString();

    // Store EVERYTHING (raw + structured)
    await db.collection("emailEvents").add({
      email,
      status,
      timestamp,
      raw: data,
    });

    if (status in ["deferred", "rejected", "failed", "complained"]) {

      try {

        // Store IMPORTANT email data (raw + structured)
        await db.collection("notifications").add({
          email,
          status,
          timestamp,
          isRead: false,
          raw: data,
        });
        console.log("Successfully added important notifications");

      } catch (error) {

        return {
          statusCode: 404,
          body: JSON.stringify({ 
            error: "Data could not be saved to database",
            errorMessage: error
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
        errorMessage: error
     }),
    };


  }
};

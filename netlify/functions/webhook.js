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

    const { MailerooClient } = await import("maileroo-sdk");
    const MAILEROO_API_KEY = process.env.MAILEROO_API_KEY;
    const mailerooClient = new MailerooClient(MAILEROO_API_KEY);

    const data = JSON.parse(event.body);

    const clientEmail = data?.clientEmail;
    const clientName = data?.clientName;
    const subject = data?.subject;
    const html = data?.html;
    const plain = data?.plain;


    //Validation checks
    if (!clientEmail || !html || !subject) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          error: "Missing required form fields.",
       }),
      };
    }


    const mailerooPayload = {
      from: { 
          address: process.env.FROM_EMAIL, 
          display_name: "Ambitrove Contact Dispacther" 
      },
      to: [{ 
          address: clientEmail, 
          display_name: clientName || "Recipient" 
      }], 
      subject: subject,
      html: html,
      plain: plain,
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
        return {
          statusCode: 400,
          body: JSON.stringify({ 
            error: "Missing required form fields.",
         }),
        };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        received: true,
        message: "Email sent successfully!",
      }),
      headers: { "Content-Type": "application/json" }
    }
    

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

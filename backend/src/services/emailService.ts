import { env } from "../config/env.js";

const RESEND_URL = "https://api.resend.com/emails";

function otpEmailHtml(name: string, code: string): string {
  const firstName = name.trim().split(/\s+/)[0] || "there";
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e8e6e1;">
            <tr>
              <td style="padding:36px 40px 0 40px;">
                <div style="display:inline-block;width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#18181a,#4a4a4d);text-align:center;line-height:28px;color:#ffffff;font-weight:800;font-size:15px;">F</div>
                <span style="font-size:18px;font-weight:800;letter-spacing:-0.02em;color:#18181a;margin-left:8px;vertical-align:middle;">Friday</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 40px 0 40px;">
                <h1 style="margin:0 0 8px 0;font-size:22px;line-height:1.3;color:#18181a;font-weight:700;">Hi ${firstName}, here's your code</h1>
                <p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:#6b6b6f;">
                  Enter this code to finish signing in to Friday. It expires in 10 minutes.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px;">
                <div style="background:#f4f4f2;border:1px solid #e8e6e1;border-radius:14px;padding:22px;text-align:center;">
                  <span style="font-family:'SF Mono',SFMono-Regular,ui-monospace,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:0.35em;color:#18181a;">${code}</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 36px 40px;">
                <p style="margin:0;font-size:13px;line-height:1.6;color:#9a9a9e;">
                  Didn't try to sign in? You can safely ignore this email — your account is still secure.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 40px;border-top:1px solid #efeeea;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#b3b3b6;">
                  © ${new Date().getFullYear()} Billionaires Technologies. All rights reserved.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendOtpEmail(to: string, name: string, code: string): Promise<void> {
  if (!env.resendApiKey) throw new Error("Email sending is not configured (missing RESEND_API_KEY)");

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.resendFromEmail,
      to: [to],
      subject: `${code} is your Friday sign-in code`,
      html: otpEmailHtml(name, code),
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to send OTP email: ${res.status} ${await res.text()}`);
  }
}

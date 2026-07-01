const { Resend } = require('resend');

const resend  = new Resend(process.env.RESEND_API_KEY);
const FROM    = 'TaskBoard <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'http://localhost:5500';

// ── Send task assignment notification ─────────────────────────
async function sendAssignmentEmail({ toEmail, toName, taskTitle, taskDescription, assignedBy }) {
  try {
    await resend.emails.send({
      from:    FROM,
      to:      toEmail,
      subject: `📋 New task assigned to you: "${taskTitle}"`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
          <h2 style="color:#1a1a2e">You have a new task</h2>
          <p>Hi ${toName},</p>
          <p><strong>${assignedBy}</strong> assigned you a task on TaskBoard.</p>
          <div style="background:#f0f2f5;border-radius:8px;padding:1rem;margin:1rem 0">
            <strong style="font-size:1rem">${taskTitle}</strong>
            ${taskDescription ? `<p style="color:#6b7280;margin:.5rem 0 0">${taskDescription}</p>` : ''}
          </div>
          <a href="${APP_URL}" style="display:inline-block;background:#4f8ef7;color:white;padding:.65rem 1.25rem;border-radius:6px;text-decoration:none;font-weight:600">
            View TaskBoard →
          </a>
          <p style="color:#9ca3af;font-size:.8rem;margin-top:2rem">TaskBoard · You're receiving this because a task was assigned to you.</p>
        </div>
      `,
    });
  } catch (err) {
    console.error('Failed to send assignment email:', err.message);
  }
}

// ── Send password reset email ─────────────────────────────────
async function sendPasswordResetEmail({ toEmail, toName, resetToken }) {
  const resetUrl = `${APP_URL}/reset-password.html?token=${resetToken}`;
  try {
    await resend.emails.send({
      from:    FROM,
      to:      toEmail,
      subject: '🔑 Reset your TaskBoard password',
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
          <h2 style="color:#1a1a2e">Reset your password</h2>
          <p>Hi ${toName},</p>
          <p>We received a request to reset your TaskBoard password. Click the button below — this link expires in <strong>1 hour</strong>.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#4f8ef7;color:white;padding:.65rem 1.25rem;border-radius:6px;text-decoration:none;font-weight:600;margin:1rem 0">
            Reset Password →
          </a>
          <p>If you didn't request this, you can safely ignore this email.</p>
          <p style="color:#9ca3af;font-size:.8rem;margin-top:2rem">TaskBoard · This link expires in 1 hour.</p>
        </div>
      `,
    });
  } catch (err) {
    console.error('Failed to send reset email:', err.message);
  }
}

// ── Send team invite email ─────────────────────────────────────
async function sendInviteEmail({ toEmail, teamName, invitedBy, inviteToken }) {
  const inviteUrl = `${APP_URL}/accept-invite.html?token=${inviteToken}`;
  try {
    await resend.emails.send({
      from:    FROM,
      to:      toEmail,
      subject: `✉️ You've been invited to join "${teamName}" on TaskBoard`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
          <h2 style="color:#1a1a2e">You're invited!</h2>
          <p><strong>${invitedBy}</strong> has invited you to join <strong>${teamName}</strong> on TaskBoard.</p>
          <a href="${inviteUrl}" style="display:inline-block;background:#4f8ef7;color:white;padding:.65rem 1.25rem;border-radius:6px;text-decoration:none;font-weight:600;margin:1rem 0">
            Accept Invite →
          </a>
          <p>This invite link expires in <strong>7 days</strong>.</p>
          <p style="color:#9ca3af;font-size:.8rem;margin-top:2rem">TaskBoard · If you weren't expecting this, you can safely ignore it.</p>
        </div>
      `,
    });
  } catch (err) {
    console.error('Failed to send invite email:', err.message);
  }
}

module.exports = { sendAssignmentEmail, sendPasswordResetEmail, sendInviteEmail };

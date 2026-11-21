import type { Env } from "./env";
import { getSettings } from "./settings";

export type UpiVerifyResult =
  | { status: "paid"; amount: number; utr: string; balance: number }
  | { status: "pending" | "expired" | "cancelled" };

export async function verifyAutoUpi(env: Env, orderId: string, userId: number): Promise<UpiVerifyResult> {
  const tx = await env.DB.prepare("SELECT * FROM upi_auto_transactions WHERE order_id=?1 AND user_id=?2")
    .bind(orderId, userId).first<any>();
  if (!tx) throw new Error("PAYMENT_NOT_FOUND");
  if (tx.status === "paid") {
    const u = await env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(userId).first<{balance_inr:number}>();
    return { status: "paid", amount: Number(tx.amount_inr), utr: String(tx.utr || ""), balance: Number(u?.balance_inr || 0) };
  }
  if (tx.status !== "pending") return { status: "cancelled" };
  if (Math.floor(Date.now()/1000) > Number(tx.expires_at)) return { status: "expired" };
  const s = await getSettings(env, { fresh: true });
  if (!s.upi_gateway_enabled || !s.upi_gateway_api_key) throw new Error("UPI_GATEWAY_NOT_CONFIGURED");
  const resp = await fetch("https://gateway.anujbots.in/autoverify.php?api_key=" + encodeURIComponent(s.upi_gateway_api_key) + "&order_id=" + encodeURIComponent(tx.gateway_order_id));
  if (!resp.ok) throw new Error("UPI_VERIFY_UNAVAILABLE");
  const result: any = await resp.json();
  const d = result?.data;
  if (String(d?.status || "").toUpperCase() !== "PAID") return { status: "pending" };
  const paidAmount = Number(d.amount);
  if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - Number(tx.amount_inr)) > 0.009) throw new Error("UPI_AMOUNT_MISMATCH");
  const now = Math.floor(Date.now()/1000);
  const utr = String(d.utr || d.transaction_id || "");
  // D1 batch is atomic. Only the request that changes pending → paid can create the ledger entry and credit the wallet.
  await env.DB.batch([
    env.DB.prepare("UPDATE upi_auto_transactions SET status='paid',utr=?2,verified_at=?3 WHERE order_id=?1 AND user_id=?4 AND status='pending'").bind(orderId, utr, now, userId),
    env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) SELECT user_id,amount_inr,'topup',id,'UPI automatic top-up',?2 FROM upi_auto_transactions WHERE order_id=?1 AND status='paid' AND verified_at=?2 AND NOT EXISTS(SELECT 1 FROM inr_ledger WHERE kind='topup' AND ref=upi_auto_transactions.id)").bind(orderId, now),
    env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2 WHERE id=?1 AND changes()=1").bind(userId, paidAmount),
  ]);
  const fresh = await env.DB.prepare("SELECT t.status,t.amount_inr,t.utr,u.balance_inr FROM upi_auto_transactions t JOIN users u ON u.id=t.user_id WHERE t.order_id=?1 AND t.user_id=?2").bind(orderId,userId).first<any>();
  if (fresh?.status !== "paid") return { status: fresh?.status === "pending" ? "pending" : "cancelled" };
  return { status: "paid", amount: Number(fresh.amount_inr), utr: String(fresh.utr || utr), balance: Number(fresh.balance_inr || 0) };
}

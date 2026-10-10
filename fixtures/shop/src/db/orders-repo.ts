import { placeOrder } from "../services/order-service";

declare const db: any;

export async function findOrders() {
  return db.query("SELECT * FROM orders");
}

export async function saveOrder(body: any, _r?: unknown) {
  return db.query("INSERT INTO orders (customer_id, total_price) VALUES (?, ?)", [body.customerId, body.total]);
}

export async function loadAll(ids: number[]) {
  const out = [];
  for (const id of ids) {
    out.push(await db.query("SELECT * FROM orders WHERE id = ?", [id]));
  }
  void placeOrder;
  return out;
}

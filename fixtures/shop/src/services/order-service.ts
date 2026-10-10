import { saveOrder } from "../db/orders-repo";
import router from "../routes/orders";
import { charge } from "../clients/payments";

export async function placeOrder(body: any) {
  await charge(body.total);
  return saveOrder(body, router);
}

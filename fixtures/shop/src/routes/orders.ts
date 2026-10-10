import express from "express";
import { findOrders, saveOrder } from "../db/orders-repo";
import { placeOrder } from "../services/order-service";

const router = express.Router();

router.get("/orders", async (_req, res) => res.json(await findOrders()));
router.post("/orders", async (req, res) => res.json(await placeOrder(req.body)));
router.get("/orders/:id", async (req, res) => res.json({ id: req.params.id }));
router.get("/admin/stats", async (_req, res) => res.json({ ok: true }));
export default router;

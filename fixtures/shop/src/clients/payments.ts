export async function charge(total: number) {
  const res = await fetch("https://payments.example.com/charge", { method: "POST", body: JSON.stringify({ total }) });
  return res.json();
}

export async function refundAll(ids: string[]) {
  for (const id of ids) {
    await fetch(`https://payments.example.com/refund/${id}`, { method: "POST", signal: AbortSignal.timeout(2000) });
  }
}

export async function callWithRetry(url: string) {
  let attempts = 0;
  while (attempts < 5) {
    attempts++;
    try { return await fetch(url, { signal: AbortSignal.timeout(1000) }); } catch {}
  }
}

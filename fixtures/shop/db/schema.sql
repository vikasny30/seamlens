CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total_price FLOAT,
  legacy_ref TEXT
);

CREATE TABLE audit_log (
  at TEXT,
  message TEXT
);

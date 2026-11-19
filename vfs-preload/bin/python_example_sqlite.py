"""Import a UTF-8 semicolon CSV into SQLite and export a reorder list."""

import csv
import sqlite3
from contextlib import closing
from pathlib import Path


def main():
    folder = Path("python-examples/sqlite")
    folder.mkdir(parents=True, exist_ok=True)
    source = folder / "inventory.csv"
    database = folder / "inventory.sqlite"
    report = folder / "reorder.csv"

    if not source.exists():
        with source.open("w", encoding="utf-8", newline="") as file:
            csv.writer(file, delimiter=";").writerows([
                ("sku", "item", "stock", "minimum"),
                ("A01", "Café; décaféiné", 3, 12),
                ("A02", "Grüner Tee", 15, 8),
                ("B01", "Müsli", 0, 6),
            ])

    with closing(sqlite3.connect(database)) as connection, connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS inventory (
                sku TEXT PRIMARY KEY, item TEXT NOT NULL,
                stock INTEGER NOT NULL, minimum INTEGER NOT NULL
            )
        """)
        connection.execute("DELETE FROM inventory")
        with source.open(encoding="utf-8", newline="") as file:
            rows = csv.DictReader(file, delimiter=";")
            connection.executemany(
                "INSERT INTO inventory VALUES (:sku, :item, :stock, :minimum)", rows
            )

    # Reopen the database file to demonstrate reading the data back from disk.
    with closing(sqlite3.connect(database)) as connection:
        orders = connection.execute("""
            SELECT sku, item, minimum - stock AS order_quantity
            FROM inventory WHERE stock < minimum
            ORDER BY order_quantity DESC, sku
        """).fetchall()

    with report.open("w", encoding="utf-8", newline="") as file:
        writer = csv.writer(file, delimiter=";")
        writer.writerow(("sku", "item", "order_quantity"))
        writer.writerows(orders)

    print(f"Wrote {database} and {report} with {len(orders)} items to reorder.")


if __name__ == "__main__":
    main()

"""Group a UTF-8 sales CSV by city and write a comma-delimited report."""

import csv
from collections import defaultdict
from decimal import Decimal
from pathlib import Path


def main():
    folder = Path("python-examples/csv")
    folder.mkdir(parents=True, exist_ok=True)
    source = folder / "sales.csv"
    report = folder / "sales_totals.csv"

    if not source.exists():
        with source.open("w", encoding="utf-8", newline="") as file:
            csv.writer(file, delimiter=",").writerows([
                ("city", "item", "units", "unit_price_eur"),
                ("Zürich", "Kaffee, dunkel", 3, "4.50"),
                ("Montréal", "Crème brûlée", 2, "5.25"),
                ("Zürich", "Birnen", 4, "1.20"),
                ("Málaga", "Oliven", 2, "3.10"),
            ])

    totals = defaultdict(Decimal)
    with source.open(encoding="utf-8", newline="") as file:
        for row in csv.DictReader(file, delimiter=","):
            totals[row["city"]] += int(row["units"]) * Decimal(row["unit_price_eur"])

    ranked = sorted(totals.items(), key=lambda item: (-item[1], item[0]))
    with report.open("w", encoding="utf-8", newline="") as file:
        writer = csv.writer(file, delimiter=",")
        writer.writerow(("city", "total_eur"))
        writer.writerows((city, f"{total:.2f}") for city, total in ranked)

    print(f"Read {source} and wrote {report} for {len(ranked)} cities.")


if __name__ == "__main__":
    main()

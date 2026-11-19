"""Convert JSON to Parquet with PyArrow, then read selected columns back."""

import csv
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


def main():
    folder = Path("python-examples/parquet")
    folder.mkdir(parents=True, exist_ok=True)
    source = folder / "stations.json"
    archive = folder / "stations.parquet"
    report = folder / "high_stations.csv"

    if not source.exists():
        sample = [
            {"station": "Zürich HB", "elevation_m": 408, "country": "CH"},
            {"station": "Innsbruck", "elevation_m": 582, "country": "AT"},
            {"station": "Växjö", "elevation_m": 165, "country": "SE"},
            {"station": "Štrbské Pleso", "elevation_m": 1350, "country": "SK"},
        ]
        source.write_text(json.dumps(sample, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    records = json.loads(source.read_text(encoding="utf-8"))
    schema = pa.schema([
        ("station", pa.string()), ("elevation_m", pa.int32()), ("country", pa.string())
    ])
    pq.write_table(pa.Table.from_pylist(records, schema=schema), archive, compression="none")

    columns = ["station", "elevation_m"]
    with pq.ParquetFile(archive) as parquet:
        rows = parquet.read(columns=columns, use_threads=False).to_pylist()
    high_stations = sorted(
        (row for row in rows if row["elevation_m"] >= 500),
        key=lambda row: row["elevation_m"], reverse=True,
    )
    with report.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=columns)
        writer.writeheader()
        writer.writerows(high_stations)

    print(f"Read back {len(rows)} rows from {archive} and wrote {report}.")


if __name__ == "__main__":
    main()

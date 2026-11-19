"""Read a weather CSV and draw an SVG chart with Matplotlib."""

import csv
from pathlib import Path

from matplotlib.backends.backend_svg import FigureCanvasSVG
from matplotlib.figure import Figure


def main():
    folder = Path("python-examples/plot")
    folder.mkdir(parents=True, exist_ok=True)
    source = folder / "temperatures.csv"

    if not source.exists():
        source.write_text(
            "month,zuerich_c\nJanuar,1.3\nFebruar,2.6\nMärz,6.3\n"
            "April,9.8\nMai,14.1\nJuni,17.9\nJuli,20.1\n",
            encoding="utf-8",
        )

    with source.open(encoding="utf-8", newline="") as file:
        rows = list(csv.DictReader(file))
    months = [row["month"] for row in rows]
    temperatures = [float(row["zuerich_c"]) for row in rows]

    figure = Figure(figsize=(8, 4), layout="constrained", facecolor="#f8fafc")
    FigureCanvasSVG(figure)
    axes = figure.subplots()
    axes.plot(months, temperatures, color="#155e75", marker="o", linewidth=2.5)
    axes.fill_between(months, 0, temperatures, color="#a5f3fc", alpha=0.7)
    axes.set(title="Zürich monthly temperatures", xlabel="Month", ylabel="Mean temperature (°C)")
    axes.grid(axis="y", alpha=0.3)

    output = folder / "temperature.svg"
    figure.savefig(output)
    print(f"Wrote {output}")


if __name__ == "__main__":
    main()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Tuple
import math
import numpy as np
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
import os


# Create the FastAPI instance
app = FastAPI()


@app.get("/", response_class=HTMLResponse) 
def read_root():
    return FileResponse('welcome.html')

@app.get("/", response_class=HTMLResponse)
def read_root():
    # Read and return your HTML file
    with open("frontend.html", "r", encoding="utf-8") as f:
        return f.read()


app = FastAPI(title="Solar API Corrected", version="2.2.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class OptimizeRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    tz: Optional[str] = None
    year: Optional[int] = None
    tilt_min: float = Field(ge=0, le=90, default=0.0)
    tilt_max: float = Field(ge=0, le=90, default=60.0)
    tilt_step: float = Field(gt=0, le=30, default=2.0)
    az_min: float = Field(ge=0, le=360, default=150.0)
    az_max: float = Field(ge=0, le=360, default=210.0)
    az_step: float = Field(gt=0, le=90, default=5.0)
    clearsky_model: str = "ineichen"
    polygon: Optional[dict] = None

def _get_direction_name(azimuth: float) -> str:
    """Get accurate direction name from azimuth angle"""
    az = azimuth % 360
    if az < 22.5 or az >= 337.5:
        return "North"
    elif az < 67.5:
        return "North-East"
    elif az < 112.5:
        return "East"
    elif az < 157.5:
        return "South-East"
    elif az < 202.5:
        return "South"  # 180° is due South
    elif az < 247.5:
        return "South-West"
    elif az < 292.5:
        return "West"
    elif az < 337.5:
        return "North-West"
    else:
        return "North"

def _calculate_realistic_annual_poa(latitude: float, longitude: float, tilt: float) -> float:
    """
    Conservative POA estimator based on latitude bands and monsoon adjustments.
    This is intentionally simple and conservative (not a radiative transfer model).
    """
    lat_abs = abs(latitude)

    # Base POA by latitude band (kWh/m²·yr), conservative values
    if lat_abs < 10:  # Equatorial
        base_poa = 1900.0
    elif lat_abs < 20:  # Tropical (includes Mumbai region)
        base_poa = 1750.0
    elif lat_abs < 30:  # Subtropical
        base_poa = 1800.0
    elif lat_abs < 45:  # Temperate
        base_poa = 1500.0
    elif lat_abs < 60:
        base_poa = 1200.0
    else:
        base_poa = 800.0

    # Monsoon-affected region adjustment (use absolute latitude and longitude bounds)
    # Indian subcontinent region roughly between lat 8-37 N and lon 68-97 E
    if 8 <= lat_abs <= 37 and 68 <= longitude <= 97:
        # coastal longitudes (western coast <77E, eastern coast >92E) tend to see extra cloudiness
        if longitude < 77 or longitude > 92:
            base_poa *= 0.85  # 15% reduction for coastal monsoon
        else:
            base_poa *= 0.90  # 10% reduction for inland monsoon

    # Tilt optimisation / penalty:
    # Use a simple, monotonic reduction as tilt moves away from the optimal tilt.
    # Optimal tilt roughly equals latitude but limited to a reasonable max (35°)
    optimal_tilt = min(lat_abs, 35.0)
    tilt_diff = abs(tilt - optimal_tilt)
    # Penalty: ~1% loss per degree difference for first ~20°, then mild saturation.
    tilt_penalty = max(0.75, 1.0 - 0.01 * tilt_diff)  # don't reduce below 75%

    poa = base_poa * tilt_penalty
    return float(poa)

def _calculate_monsoon_aware_monthly(latitude: float, longitude: float, annual_total: float) -> List[float]:
    """Calculate a realistic monthly distribution accounting for monsoon patterns."""
    lat_abs = abs(latitude)
    is_monsoon_region = (8 <= lat_abs <= 37 and 68 <= longitude <= 97)

    if is_monsoon_region:
        # Monsoon-affected monthly pattern (relative weights). Low in Jun-Jul-Aug.
        monthly_factors = [
            0.90,  # Jan
            0.85,  # Feb
            1.05,  # Mar
            1.10,  # Apr
            1.05,  # May
            0.60,  # Jun
            0.50,  # Jul
            0.55,  # Aug
            0.70,  # Sep
            0.95,  # Oct
            0.90,  # Nov
            0.90   # Dec
        ]
    else:
        # Simple tropical/temperate split
        if lat_abs < 23.5:
            monthly_factors = [0.84, 0.86, 0.89, 0.88, 0.85, 0.78, 0.80, 0.83, 0.85, 0.87, 0.87, 0.85]
        elif lat_abs < 45:
            monthly_factors = [0.63, 0.71, 0.84, 0.95, 1.06, 1.08, 1.09, 1.03, 0.88, 0.76, 0.62, 0.55]
        else:
            monthly_factors = [0.35, 0.55, 0.82, 1.08, 1.28, 1.35, 1.33, 1.15, 0.88, 0.65, 0.40, 0.26]

    # Southern hemisphere adjustment (shift by 6 months)
    if latitude < 0:
        monthly_factors = monthly_factors[6:] + monthly_factors[:6]

    total_factor = sum(monthly_factors)
    monthly_fractions = [f / total_factor for f in monthly_factors]
    monthly_values = [annual_total * frac for frac in monthly_fractions]

    # small numeric fix to ensure exact sum equals annual_total
    actual_sum = sum(monthly_values)
    if actual_sum > 0:
        scale = annual_total / actual_sum
        monthly_values = [v * scale for v in monthly_values]

    return monthly_values

def _shortest_angular_diff(a1: float, a2: float) -> float:
    """Return the smallest difference between two angles in degrees (0..180)."""
    diff = abs((a1 - a2) % 360)
    return min(diff, 360 - diff)

def _optimize_tilt_azimuth(latitude: float, longitude: float, min_tilt: float, max_tilt: float,
                          tilt_step: float, min_az: float, max_az: float, az_step: float) -> Tuple[float, float, float, int]:
    """Find optimal tilt and azimuth using the improved POA estimator and correct angular math."""
    best_poa = -1.0
    best_tilt = min_tilt
    best_az = min_az

    # Build arrays using the exact step values provided (inclusive of max using a small epsilon)
    eps = 1e-9
    if tilt_step <= 0:
        tilt_step = 2.0
    if az_step <= 0:
        az_step = 5.0

    test_tilts = np.arange(min_tilt, max_tilt + eps, tilt_step)
    test_azs = np.arange(min_az, max_az + eps, az_step)
    evaluated = 0

    for tilt in test_tilts:
        for az in test_azs:
            evaluated += 1
            # Base POA from tilt/lat/long estimator
            poa = _calculate_realistic_annual_poa(latitude, longitude, float(tilt))

            # Azimuth penalty using shortest angular difference
            optimal_az = 180.0 if latitude >= 0 else 0.0
            ang_diff = _shortest_angular_diff(az, optimal_az)
            # Use 0.4% loss per degree as a reasonably conservative penalty (clamped)
            az_penalty = 1.0 - 0.004 * ang_diff
            az_penalty = max(0.60, az_penalty)  # do not reduce below 60%
            poa *= az_penalty

            if poa > best_poa:
                best_poa = poa
                best_tilt = float(tilt)
                best_az = float(az)

    # If nothing evaluated (shouldn't happen), fallback to defaults
    if evaluated == 0:
        evaluated = 1
        best_poa = _calculate_realistic_annual_poa(latitude, longitude, min_tilt)

    return best_tilt, best_az, float(best_poa), evaluated

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/optimize")
def optimize(req: OptimizeRequest):
    # Find optimal configuration using the provided steps
    opt_tilt, opt_az, annual_poa, evaluated = _optimize_tilt_azimuth(
        req.lat, req.lon, req.tilt_min, req.tilt_max, req.tilt_step,
        req.az_min, req.az_max, req.az_step
    )

    # Monthly distribution
    monthly_values = _calculate_monsoon_aware_monthly(req.lat, req.lon, annual_poa)

    # Second best (a simple heuristic)
    second_best = annual_poa * 0.95

    direction = _get_direction_name(opt_az)

    # Find month names for peak / low
    month_names = ['January', 'February', 'March', 'April', 'May', 'June',
                   'July', 'August', 'September', 'October', 'November', 'December']
    max_idx = int(np.argmax(monthly_values))
    min_idx = int(np.argmin(monthly_values))

    response = {
        "tilt_deg": round(opt_tilt, 1),
        "azimuth_deg": round(opt_az, 0),
        "annual_poa_kwh_m2": round(annual_poa, 0),
        "evaluated": int(evaluated),
        "best_point": [req.lon, req.lat],
        "orientation_text": f"Face panels toward {direction} ({int(round(opt_az))}°) at {opt_tilt:.1f}° tilt",
        "monthly_poa_kwh": [round(v, 1) for v in monthly_values],
        "heatmap": [{"tilt": round(opt_tilt, 1), "az": round(opt_az, 1), "kwh": round(annual_poa, 1)}],
        "second_best_kwh": round(second_best, 0),
        "summary_text": (
            f"The solar array is optimally positioned at a {opt_tilt:.1f}° tilt angle, "
            f"facing {direction.lower()} (azimuth {int(round(opt_az))}°). "
            f"This configuration maximizes solar energy capture, delivering an estimated {int(round(annual_poa))} "
            f"kilowatt-hours per square meter annually on the plane of the panels. "
            f"Peak production occurs in {month_names[max_idx]} ({monthly_values[max_idx]:.0f} kWh/m²), "
            f"while {month_names[min_idx]} shows the lowest output ({monthly_values[min_idx]:.0f} kWh/m²). "
            "For optimal performance, ensure panels remain unshaded during peak sun hours (9 AM - 3 PM), "
            "perform regular cleaning to remove dust and debris, and conduct quarterly inspections."
        ),
        "simple_summary": (
            f"It shows a solar array oriented at a tilt of {int(round(opt_tilt))}° and an azimuth of "
            f"{int(round(opt_az))}° (facing {direction.lower()}), with an estimated annual POA of "
            f"{int(round(annual_poa))} kWh/m², meaning the surface is expected to receive about "
            f"{int(round(annual_poa))} kilowatt-hours per square meter over a year on the plane of the panels."
        )
    }

    return response

package com.naeodiga.app;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 위경도 <-> nav.json 맵 좌표. 정합 결과는 assets/ar_meta.json (ybyb_test/georef/georef.py).
 * E,N = R(rot)·(x,-z)+t, E = (lng-lng0)·KX, N = (lat-lat0)·KY.
 */
final class Georef {
    private final double lat0, lng0, kx, ky, cos, sin, tx, ty;

    Georef(String metaJson) throws Exception {
        JSONObject meta = new JSONObject(metaJson);
        JSONArray origin = meta.getJSONArray("origin_latlng"), t = meta.getJSONArray("translation_en_m");
        lat0 = origin.getDouble(0);
        lng0 = origin.getDouble(1);
        kx = 111320 * Math.cos(Math.toRadians(lat0));
        ky = 110540;
        double rot = Math.toRadians(meta.getDouble("rotation_deg"));
        cos = Math.cos(rot);
        sin = Math.sin(rot);
        tx = t.getDouble(0);
        ty = t.getDouble(1);
    }

    /** Map-frame {x, z} of a lat/lng. */
    float[] toMap(double lat, double lng) {
        double e = (lng - lng0) * kx - tx, n = (lat - lat0) * ky - ty;
        double u = cos * e + sin * n, v = -sin * e + cos * n;  // R^-1 · (E,N) = (x, -z)
        return new float[]{(float)u, (float)-v};
    }

    /** 진북 기준 방위각(도, 시계 방향)이 지도 좌표에서 가리키는 수평 방향 {dx, dz}. */
    float[] directionToMap(double bearingDegrees) {
        double e = Math.sin(Math.toRadians(bearingDegrees)), n = Math.cos(Math.toRadians(bearingDegrees));
        double u = cos * e + sin * n, v = -sin * e + cos * n;
        return new float[]{(float)u, (float)-v};
    }

    /** {lat, lng} of a map-frame x,z. */
    double[] toLatLng(float x, float z) {
        double e = cos * x - sin * -z + tx, n = sin * x + cos * -z + ty;
        return new double[]{lat0 + n / ky, lng0 + e / kx};
    }

    /**
     * Graph node standing in front of a room: nearest node on that floor (floor name "N층", 0 = unknown -> any).
     * Rooms sit beside the corridor, so the nearest corridor node is the spot in front of the door.
     * Returns -1 if the room is farther than maxDistance from every node (not covered by this map).
     */
    static int nodeFor(NavMap map, float x, float z, int floor, float maxDistance) {
        float floorY = Float.NaN;
        if (floor > 0) {
            for (int i = 0; i < map.floors.length(); i++) {
                JSONObject f = map.floors.optJSONObject(i);
                if (f.optString("name").equals(floor + "층")) floorY = (float)f.optDouble("y");
            }
            if (Float.isNaN(floorY)) return -1;
        }
        int best = -1;
        float bestD = maxDistance * maxDistance;
        for (int i = 0; i < map.nodes.length; i++) {
            float[] n = map.nodes[i];
            if (!Float.isNaN(floorY) && Math.abs(n[1] - floorY) > 1.2f) continue;  // camera height varies a little within a floor
            float d = (n[0] - x) * (n[0] - x) + (n[2] - z) * (n[2] - z);
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    }
}

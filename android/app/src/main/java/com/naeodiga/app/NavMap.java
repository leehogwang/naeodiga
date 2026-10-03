package com.naeodiga.app;

import org.json.JSONArray;
import org.json.JSONObject;

/** nav.json (from nav.py) without Android: walk graph, floors, anchors, map <-> session alignment. */
final class NavMap {
    final float[][] nodes;
    final int[][] neighbours;
    final JSONArray anchors, floors;

    NavMap(String json) throws Exception {
        JSONObject data = new JSONObject(json);
        JSONArray points = data.getJSONArray("nodes"), edges = data.getJSONArray("edges");
        nodes = new float[points.length()][];
        for (int i = 0; i < nodes.length; i++) {
            JSONArray p = points.getJSONArray(i);
            nodes[i] = new float[]{(float)p.getDouble(0), (float)p.getDouble(1), (float)p.getDouble(2)};
        }
        int[] degree = new int[nodes.length];
        for (int i = 0; i < edges.length(); i++) {
            degree[edges.getJSONArray(i).getInt(0)]++;
            degree[edges.getJSONArray(i).getInt(1)]++;
        }
        neighbours = new int[nodes.length][];
        for (int i = 0; i < nodes.length; i++) neighbours[i] = new int[degree[i]];
        int[] filled = new int[nodes.length];
        for (int i = 0; i < edges.length(); i++) {
            int a = edges.getJSONArray(i).getInt(0), b = edges.getJSONArray(i).getInt(1);
            neighbours[a][filled[a]++] = b;
            neighbours[b][filled[b]++] = a;
        }
        anchors = data.getJSONArray("anchors");
        floors = data.getJSONArray("floors");
    }

    String floorOf(float y) {
        String best = "";
        float distance = Float.MAX_VALUE;
        for (int i = 0; i < floors.length(); i++) {
            JSONObject floor = floors.optJSONObject(i);
            float d = Math.abs((float)floor.optDouble("y") - y);
            if (d < distance) { distance = d; best = floor.optString("name"); }
        }
        return best;
    }

    int nearest(float[] p) {
        int best = 0;
        float bestScore = Float.MAX_VALUE;
        for (int i = 0; i < nodes.length; i++) {
            float dx = nodes[i][0] - p[0], dy = (nodes[i][1] - p[1]) * 3, dz = nodes[i][2] - p[2];  // stay on this floor
            float score = dx * dx + dy * dy + dz * dz;
            if (score < bestScore) { bestScore = score; best = i; }
        }
        return best;
    }

    /** Dijkstra over ~1k nodes; fast enough to rerun every second as the user walks. Empty if unreachable. */
    int[] shortestPath(int start, int goal) {
        float[] cost = new float[nodes.length];
        int[] previous = new int[nodes.length];
        java.util.Arrays.fill(cost, Float.MAX_VALUE);
        java.util.Arrays.fill(previous, -1);
        cost[start] = 0;
        java.util.PriorityQueue<float[]> queue = new java.util.PriorityQueue<>((a, b) -> Float.compare(a[0], b[0]));
        queue.add(new float[]{0, start});
        while (!queue.isEmpty()) {
            float[] item = queue.poll();
            int node = (int)item[1];
            if (item[0] > cost[node]) continue;
            if (node == goal) break;
            for (int next : neighbours[node]) {
                float c = cost[node] + distance(nodes[node], nodes[next]);
                if (c < cost[next]) { cost[next] = c; previous[next] = node; queue.add(new float[]{c, next}); }
            }
        }
        if (cost[goal] == Float.MAX_VALUE) return new int[0];
        java.util.ArrayList<Integer> route = new java.util.ArrayList<>();
        for (int node = goal; node != -1; node = previous[node]) route.add(0, node);
        int[] result = new int[route.size()];
        for (int i = 0; i < result.length; i++) result[i] = route.get(i);
        return result;
    }

    static float distance(float[] a, float[] b) {
        float x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
        return (float)Math.sqrt(x * x + y * y + z * z);
    }

    /** Heading of a pose's +Z axis around gravity (ARCore +Y up). */
    static float yaw(float zAxisX, float zAxisZ) { return (float)Math.atan2(zAxisX, zAxisZ); }

    /**
     * Map -> session from one anchor seen in both: same anchor, map pose (from nav.json) and resolved pose.
     * Yaw + translation only; both frames keep gravity on +Y, so tilt noise of the anchor is ignored.
     */
    static final class Alignment {
        final float[] mapOrigin, userOrigin;
        final float cos, sin;

        Alignment(float[] mapOrigin, float mapYaw, float[] userOrigin, float userYaw) {
            this.mapOrigin = mapOrigin.clone();
            this.userOrigin = userOrigin.clone();
            cos = (float)Math.cos(userYaw - mapYaw);
            sin = (float)Math.sin(userYaw - mapYaw);
        }

        static Alignment fromAnchor(JSONArray mapPose, float[] userOrigin, float[] userZAxis) throws Exception {
            float[] origin = {(float)mapPose.getJSONArray(0).getDouble(3), (float)mapPose.getJSONArray(1).getDouble(3),
                    (float)mapPose.getJSONArray(2).getDouble(3)};
            float mapYaw = yaw((float)mapPose.getJSONArray(0).getDouble(2), (float)mapPose.getJSONArray(2).getDouble(2));
            return new Alignment(origin, mapYaw, userOrigin, yaw(userZAxis[0], userZAxis[2]));
        }

        float[] toUser(float[] p) {
            float x = p[0] - mapOrigin[0], z = p[2] - mapOrigin[2];
            return new float[]{cos * x + sin * z + userOrigin[0], p[1] - mapOrigin[1] + userOrigin[1],
                    -sin * x + cos * z + userOrigin[2]};
        }

        float[] toMap(float[] p) {
            float x = p[0] - userOrigin[0], z = p[2] - userOrigin[2];
            return new float[]{cos * x - sin * z + mapOrigin[0], p[1] - userOrigin[1] + mapOrigin[1],
                    sin * x + cos * z + mapOrigin[2]};
        }
    }
}

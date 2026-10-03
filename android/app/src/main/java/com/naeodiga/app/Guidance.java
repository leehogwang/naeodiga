package com.naeodiga.app;

import java.util.ArrayList;
import java.util.List;

/**
 * 경로(세션 좌표, +Y 위) 위에서 화살표 위치·방향과 다음 회전 안내를 계산한다. Android 의존 없음.
 * 방향 부호: 위에서 보고 앞이 -z일 때 오른쪽이 +x. cross(앞, 목표) > 0 이면 오른쪽.
 */
final class Guidance {
    static final float CAMERA_HEIGHT = 1.2f;  // 그래프 노드는 촬영 카메라 위치라 바닥은 1.2m 아래

    final float[][] route;  // 바닥 높이로 내린 경로 점
    final float[] cum;      // 각 점까지의 누적 거리
    final float total;

    Guidance(float[][] route) {
        this.route = route;
        cum = new float[route.length];
        for (int i = 1; i < route.length; i++) cum[i] = cum[i - 1] + NavMap.distance(route[i - 1], route[i]);
        total = route.length == 0 ? 0 : cum[route.length - 1];
    }

    /** 경로 위에서 here와 가장 가까운 지점까지의 거리(경로 시작부터). 층을 가로지르지 않도록 높이 차에 가중치. */
    float progress(float[] here) {
        float bestScore = Float.MAX_VALUE, best = 0;
        for (int i = 0; i + 1 < route.length; i++) {
            float[] a = route[i], b = route[i + 1];
            float dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
            float len2 = dx * dx + dy * dy + dz * dz;
            float t = len2 == 0 ? 0 : ((here[0] - a[0]) * dx + (here[1] - CAMERA_HEIGHT - a[1]) * dy + (here[2] - a[2]) * dz) / len2;
            t = Math.max(0, Math.min(1, t));
            float px = a[0] + dx * t - here[0], py = (a[1] + dy * t - (here[1] - CAMERA_HEIGHT)) * 3, pz = a[2] + dz * t - here[2];
            float score = px * px + py * py + pz * pz;
            if (score < bestScore) { bestScore = score; best = cum[i] + (float)Math.sqrt(len2) * t; }
        }
        return best;
    }

    float[] pointAt(float s) {
        if (route.length == 0) return new float[3];
        s = Math.max(0, Math.min(total, s));
        int i = 0;
        while (i + 2 < route.length && cum[i + 1] < s) i++;
        if (route.length == 1) return route[0].clone();
        float seg = cum[i + 1] - cum[i], t = seg == 0 ? 0 : (s - cum[i]) / seg;
        float[] a = route[i], b = route[i + 1];
        return new float[]{a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t};
    }

    /** s 지점에서 진행 방향의 수평 yaw (라디안, +Z 기준 atan2(x, z)). 걸어서 모은 경로의 지그재그를 ±window로 평균. */
    float yawAt(float s, float window) {
        float[] a = pointAt(s - window), b = pointAt(s + window);
        return (float)Math.atan2(b[0] - a[0], b[2] - a[2]);
    }

    static final class Arrow {
        final float x, y, z, yaw;
        Arrow(float x, float y, float z, float yaw) { this.x = x; this.y = y; this.z = z; this.yaw = yaw; }
    }

    /** s0 앞쪽으로 spacing 간격 화살표. 목적지 바로 앞(0.8m 안)에서는 그리지 않는다. */
    List<Arrow> arrows(float s0, float first, float spacing, float maxAhead) {
        List<Arrow> out = new ArrayList<>();
        for (float s = s0 + first; s <= s0 + maxAhead && s < total - 0.8f; s += spacing) {
            float[] p = pointAt(s);
            out.add(new Arrow(p[0], p[1], p[2], yawAt(s, 1.0f)));
        }
        return out;
    }

    static final class Turn {
        final float distance, degrees;  // 양수 = 오른쪽
        Turn(float distance, float degrees) { this.distance = distance; this.degrees = degrees; }
    }

    /**
     * 앞으로 경로를 따라가다 처음 minDegrees 넘게 꺾이는 곳. 없으면 null (끝까지 직진).
     * 3m 창의 방향 변화로 찾으므로 창이 모퉁이에 막 걸쳤을 때 잡힌다: 모퉁이는 창 시작 + 1.4m 쯤(minDegrees 50°일 때).
     */
    Turn nextTurn(float s0, float minDegrees) {
        float base = yawAt(s0 + 1.5f, 1.5f);
        for (float s = s0 + 3f; s < total - 1f; s += .5f) {
            float diff = wrap(base - yawAt(s + 1.5f, 1.5f));  // yaw는 오른쪽으로 갈수록 줄어든다 -> 양수 = 오른쪽
            if (Math.abs(Math.toDegrees(diff)) >= minDegrees) return new Turn(Math.max(0, s + 1.4f - s0), (float)Math.toDegrees(diff));
        }
        return null;
    }

    /** 앞(forward)을 기준으로 목표 방향(수평)이 몇 도 돌아가 있나. 양수 = 오른쪽, 범위 -180..180. */
    static float relativeDegrees(float forwardX, float forwardZ, float dirX, float dirZ) {
        float cross = forwardX * dirZ - forwardZ * dirX, dot = forwardX * dirX + forwardZ * dirZ;
        return (float)Math.toDegrees(Math.atan2(cross, dot));
    }

    private static float wrap(float a) {
        while (a > Math.PI) a -= 2 * Math.PI;
        while (a < -Math.PI) a += 2 * Math.PI;
        return a;
    }

    /** NavMap 경로(노드 번호)를 세션 좌표 + 바닥 높이 점들로. */
    static float[][] toFloorRoute(NavMap map, int[] path, NavMap.Alignment alignment) {
        float[][] points = new float[path.length][];
        for (int i = 0; i < path.length; i++) {
            float[] p = alignment.toUser(map.nodes[path[i]]);
            points[i] = new float[]{p[0], p[1] - CAMERA_HEIGHT, p[2]};
        }
        return points;
    }
}

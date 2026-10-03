package com.naeodiga.app;

import java.util.ArrayList;

/**
 * Cloud Anchor 없이 지도와 AR 세션을 맞춘다. 입구에 선 순간을 "입구 노드 위치"로 보고, 방향은 나침반으로 정한다.
 * 이후 걸으면서 ARCore가 잰 이동 방향을 경로 방향에 맞춰 나침반 오차를 줄여 간다 (맵 매칭).
 * Android 의존 없음. 정렬은 yaw + 평행이동 (NavMap.Alignment와 같은 규약).
 */
final class DoorLocalizer {
    private static final float STEP = .25f, WINDOW = 4f, MIN_CHORD = 3f, MAX_DEVIATION = .8f, MAX_CORRECTION_DEG = 45f, GAIN = .5f;

    private float[] mapOrigin, userOrigin;
    private float yaw;  // userYaw - mapYaw
    private final ArrayList<float[]> trail = new ArrayList<>();  // 세션 좌표 카메라 위치, STEP 이상 움직일 때마다
    private final ArrayList<Float> trailLength = new ArrayList<>();
    private float evaluatedAt;

    /** doorMap: 입구 노드(지도 좌표), cam: 그때 카메라(세션 좌표), camYaw*: 카메라 앞방향의 수평 yaw = atan2(x, z). */
    DoorLocalizer(float[] doorMap, float[] cam, float camYawUser, float camYawMap) {
        mapOrigin = doorMap.clone();
        userOrigin = cam.clone();
        yaw = camYawUser - camYawMap;
        addTrail(cam);
    }

    NavMap.Alignment alignment() { return new NavMap.Alignment(mapOrigin, 0, userOrigin, yaw); }

    float yawRadians() { return yaw; }

    private void addTrail(float[] cam) {
        float length = trail.isEmpty() ? 0 : trailLength.get(trailLength.size() - 1);
        if (!trail.isEmpty()) {
            float step = NavMap.distance(trail.get(trail.size() - 1), cam);
            if (step < STEP) return;
            length += step;
        }
        trail.add(cam.clone());
        trailLength.add(length);
    }

    /**
     * 최근 WINDOW m를 거의 직선으로 걸었으면, 그 이동 방향이 경로(지도 좌표 Guidance) 방향과 같다고 보고 yaw를 조금 고친다.
     * 경로에서 크게(45° 넘게) 벗어난 방향이면 사용자가 경로를 안 따라간 것으로 보고 무시. 고친 각도(도)를 돌려준다.
     */
    float refine(float[] cam, Guidance routeMap) {
        addTrail(cam);
        float total = trailLength.get(trailLength.size() - 1);
        if (total - evaluatedAt < 1f || total < MIN_CHORD) return 0;
        evaluatedAt = total;
        int start = trail.size() - 1;
        while (start > 0 && total - trailLength.get(start) < WINDOW) start--;
        float[] a = trail.get(start), b = trail.get(trail.size() - 1);
        float dx = b[0] - a[0], dz = b[2] - a[2], chord = (float)Math.hypot(dx, dz);
        if (chord < MIN_CHORD) return 0;
        for (int i = start; i < trail.size(); i++) {  // 직선으로 걸었나
            float[] p = trail.get(i);
            if (Math.abs((p[0] - a[0]) * dz - (p[2] - a[2]) * dx) / chord > MAX_DEVIATION) return 0;
        }
        NavMap.Alignment now = alignment();
        float[] aMap = now.toMap(a), bMap = now.toMap(b);
        float s = routeMap.progress(bMap);
        if (s < chord) return 0;
        float straight = wrap(routeMap.yawAt(s - chord * .75f, chord / 4) - routeMap.yawAt(s - chord * .25f, chord / 4));
        if (Math.abs(Math.toDegrees(straight)) > 25) return 0;  // 경로가 굽은 곳은 방향 비교가 부정확
        float walked = (float)Math.atan2(bMap[0] - aMap[0], bMap[2] - aMap[2]);
        float delta = wrap(routeMap.yawAt(s - chord / 2, chord / 2) - walked);
        if (Math.abs(Math.toDegrees(delta)) > MAX_CORRECTION_DEG) return 0;
        float applied = GAIN * delta;
        mapOrigin = bMap;  // 지금 서 있는 곳을 축으로 돌려서 위치가 튀지 않게
        userOrigin = b.clone();
        yaw -= applied;
        float[] last = trail.get(trail.size() - 1);
        trail.clear();
        trailLength.clear();
        evaluatedAt = 0;
        addTrail(last);
        return (float)Math.toDegrees(applied);
    }

    private static float wrap(float a) {
        while (a > Math.PI) a -= 2 * Math.PI;
        while (a < -Math.PI) a += 2 * Math.PI;
        return a;
    }
}

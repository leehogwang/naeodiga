package com.naeodiga.app;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;

/** 실제 nav.json·정합값으로: 위경도 변환, 호실 -> 노드, 화살표 배치, 회전 안내, 메시 법선. ARCore/GL 없이 JVM에서 돈다. */
public final class ArCheck {
    public static void main(String[] args) throws Exception {
        NavMap map = new NavMap(new String(Files.readAllBytes(Paths.get(args[0])), "UTF-8"));
        Georef geo = new Georef(new String(Files.readAllBytes(Paths.get(args[1])), "UTF-8"));

        // 1) georef: 정문 앵커(-3.01,-0.71,52.78)는 georef_result.json이 준 위경도로 가야 한다 (그 스크립트와 같은 식인지)
        double[] ll = geo.toLatLng(-3.0104f, 52.7807f);  // nav.json 앵커 정확 값은 아래에서 다시 확인
        for (int i = 0; i < map.anchors.length(); i++) {
            if (!map.anchors.getJSONObject(i).getString("name").equals("과기대 1층 정문")) continue;
            org.json.JSONArray pose = map.anchors.getJSONObject(i).getJSONArray("pose");
            ll = geo.toLatLng((float)pose.getJSONArray(0).getDouble(3), (float)pose.getJSONArray(2).getDouble(3));
        }
        assert Math.abs(ll[0] - 36.948870802666654) < 1e-6 && Math.abs(ll[1] - 127.90715541653239) < 1e-6 : "정문 위경도 " + ll[0] + "," + ll[1];
        float[] back = geo.toMap(ll[0], ll[1]);
        double[] again = geo.toLatLng(back[0], back[1]);
        assert Math.abs(again[0] - ll[0]) < 1e-9 && Math.abs(again[1] - ll[1]) < 1e-9 : "왕복";

        // 2) 호실(DB 손 보정 GPS) -> 1층 노드: 복도 노드가 호실에서 멀지 않고, 정문에서 경로가 있어야 한다
        double[][] rooms = {{36.9488104, 127.9073355}, {36.9488858, 127.907196}, {36.9490566, 127.9066592}, {36.9491234, 127.9067526}, {36.9489697, 127.9068293}};
        int door = -1;
        for (int i = 0; i < map.anchors.length(); i++) if (map.anchors.getJSONObject(i).getString("name").equals("과기대 1층 정문")) door = map.anchors.getJSONObject(i).getInt("node");
        float worst = 0;
        for (double[] r : rooms) {
            float[] xz = geo.toMap(r[0], r[1]);
            int node = Georef.nodeFor(map, xz[0], xz[1], 1, 25f);
            assert node >= 0 : "호실 노드 없음";
            float d = (float)Math.hypot(map.nodes[node][0] - xz[0], map.nodes[node][2] - xz[1]);
            worst = Math.max(worst, d);
            assert map.floorOf(map.nodes[node][1]).equals("1층");
            assert map.shortestPath(door, node).length > 0 : "정문에서 경로 없음";
        }
        assert Georef.nodeFor(map, 500, 500, 1, 25f) == -1 : "지도 밖은 -1";
        assert Georef.nodeFor(map, 0, 0, 9, 25f) == -1 : "없는 층은 -1";
        System.out.printf("호실 5곳 -> 복도 노드 최대 %.1f m, 정문에서 모두 경로 있음%n", worst);

        // 3) 쉐브론 메시: 삼각형 단위, 법선 단위 길이, 옆면 법선이 바깥쪽 (윤곽에서 법선 쪽으로 조금 나가면 윤곽 밖)
        float[] mesh = ChevronMesh.build();
        assert mesh.length % 18 == 0;
        float[][] o = {{-ChevronMesh.W, 0}, {0, ChevronMesh.L}, {ChevronMesh.W, 0}, {ChevronMesh.W, -ChevronMesh.T}, {0, ChevronMesh.L - ChevronMesh.T}, {-ChevronMesh.W, -ChevronMesh.T}};
        for (int i = 0; i < mesh.length; i += 6) {
            float nl = (float)Math.sqrt(mesh[i + 3] * mesh[i + 3] + mesh[i + 4] * mesh[i + 4] + mesh[i + 5] * mesh[i + 5]);
            assert Math.abs(nl - 1) < 1e-4 && mesh[i + 1] >= -1e-6 && mesh[i + 1] <= ChevronMesh.H + 1e-6;
        }
        for (int i = 0; i < mesh.length; i += 18) {  // 삼각형마다
            if (mesh[i + 4] != 0) continue;  // 윗면은 건너뜀
            // 옆면: 세 꼭짓점 평균은 그 변 위(모서리 정점은 오목한 곳에서 판정이 흔들려 쓰지 않음)
            float cx = (mesh[i] + mesh[i + 6] + mesh[i + 12]) / 3, cz = (mesh[i + 2] + mesh[i + 8] + mesh[i + 14]) / 3;
            assert !inside(o, cx + mesh[i + 3] * .005f, cz + mesh[i + 5] * .005f) : "옆면 법선이 안쪽을 향함 @" + cx + "," + cz;
            assert inside(o, cx - mesh[i + 3] * .005f, cz - mesh[i + 5] * .005f) : "옆면 반대쪽이 윤곽 안이 아님 @" + cx + "," + cz;
        }

        // 4) 화살표/회전: ㄱ자 경로 (앞이 -z, 10m 직진 후 오른쪽 +x로 10m)
        float[][] rightL = {{0, 0, 0}, {0, 0, -10}, {10, 0, -10}};
        Guidance g = new Guidance(rightL);
        Guidance.Turn t = g.nextTurn(0, 50);
        assert t != null && t.degrees > 60 && t.degrees < 120 && Math.abs(t.distance - 10) < 1.5f : "오른쪽 회전 " + (t == null ? null : t.distance + "m " + t.degrees + "°");
        float[][] leftL = {{0, 0, 0}, {0, 0, -10}, {-10, 0, -10}};
        Guidance.Turn tl = new Guidance(leftL).nextTurn(0, 50);
        assert tl != null && tl.degrees < -60 : "왼쪽 회전";
        assert new Guidance(new float[][]{{0, 0, 0}, {0, 0, -20}}).nextTurn(0, 50) == null : "직선은 회전 없음";
        List<Guidance.Arrow> arrows = g.arrows(0, 1.4f, 1f, 9f);
        assert arrows.size() >= 7 : "화살표 개수 " + arrows.size();
        Guidance.Arrow first = arrows.get(0);
        assert Math.abs(first.z + 1.4f) < 1e-3 && Math.abs(first.yaw - (float)Math.PI) < .2f : "처음 화살표는 앞(-z)을 향함 yaw=" + first.yaw;  // yaw π = +Z 반대 = -z
        Guidance.Arrow late = g.arrows(8f, 1.4f, 1f, 9f).get(3);  // 모퉁이를 돈 뒤: +x 쪽
        assert late.x > 0.5f && Math.abs(late.yaw - (float)Math.PI / 2) < .5f : "모퉁이 뒤 화살표는 +x를 향함 yaw=" + late.yaw;
        assert Math.abs(g.progress(new float[]{0.4f, 1.2f, -5f}) - 5f) < .1f : "진행 거리";
        assert g.progress(new float[]{0, 1.2f, 3f}) == 0f : "경로 앞쪽은 시작점에 붙음";
        assert Math.abs(Guidance.relativeDegrees(0, -1, 1, 0) - 90) < 1e-3 && Math.abs(Guidance.relativeDegrees(0, -1, -1, 0) + 90) < 1e-3
                && Math.abs(Math.abs(Guidance.relativeDegrees(0, -1, 0, 1)) - 180) < 1e-3 : "휴대폰 기준 좌우";

        // 5) 실제 경로: 정문 -> 3층 엘베. 화살표는 전부 경로 위, 진행 방향과 같은 쪽
        int lift3 = -1;
        for (int i = 0; i < map.anchors.length(); i++) if (map.anchors.getJSONObject(i).getString("name").equals("과기대 3층 엘베")) lift3 = map.anchors.getJSONObject(i).getInt("node");
        int[] path = map.shortestPath(door, lift3);
        NavMap.Alignment id = new NavMap.Alignment(new float[3], 0, new float[3], 0);
        Guidance real = new Guidance(Guidance.toFloorRoute(map, path, id));
        assert Math.abs(real.total - 88f) < 1.5f : "경로 길이 " + real.total;
        for (float s0 = 0; s0 < real.total - 10; s0 += 7) {
            for (Guidance.Arrow a : real.arrows(s0, 1.4f, 1f, 9f)) {
                float best = Float.MAX_VALUE;
                for (float s = 0; s <= real.total; s += .05f) best = Math.min(best, NavMap.distance(real.pointAt(s), new float[]{a.x, a.y, a.z}));
                assert best < .06f : "화살표가 경로를 벗어남 " + best;
            }
        }

        // 6) 나침반 방향 -> 지도 방향: 지도에서 두 점을 잇는 방향의 실제 방위각을 위경도로 구해 되돌렸을 때 같은 방향이어야 함
        float[] p0 = map.nodes[door], p1 = map.nodes[path[12]];
        double[] l0 = geo.toLatLng(p0[0], p0[2]), l1 = geo.toLatLng(p1[0], p1[2]);
        double bearing = Math.toDegrees(Math.atan2((l1[1] - l0[1]) * 111320 * Math.cos(Math.toRadians(l0[0])), (l1[0] - l0[0]) * 110540));
        float[] dir = geo.directionToMap(bearing);
        float mx = p1[0] - p0[0], mz = p1[2] - p0[2], ml = (float)Math.hypot(mx, mz);
        assert (dir[0] * mx + dir[1] * mz) / ml > .999f : "방위각 -> 지도 방향 불일치";

        // 7) 맵 매칭: 나침반 yaw가 25° 틀린 채 시작해도 경로를 따라 걸으면 맞춰져야 한다 (실제 경로 정문 -> 3층 엘베 앞쪽 40m)
        NavMap.Alignment truth = new NavMap.Alignment(map.nodes[door], 0, new float[]{7, map.nodes[door][1] + .1f, -3}, 0.9f);
        Guidance routeMap = new Guidance(Guidance.toFloorRoute(map, path, id));
        for (double error : new double[]{25, -30, 12}) {
            DoorLocalizer loc = new DoorLocalizer(map.nodes[door], truth.toUser(map.nodes[door]), 0.9f + (float)Math.toRadians(error), 0f);
            float walkedTo = 0, applied = 0;
            for (float s = 0.25f; s <= 40f; s += .25f) {
                float[] m = routeMap.pointAt(s);
                float[] user = truth.toUser(new float[]{m[0], m[1] + Guidance.CAMERA_HEIGHT, m[2]});
                float c = loc.refine(user, routeMap); applied += Math.abs(c);
            }
            float[] end = routeMap.pointAt(40f);
            float[] endMap = {end[0], end[1] + Guidance.CAMERA_HEIGHT, end[2]};
            float off = NavMap.distance(loc.alignment().toUser(endMap), truth.toUser(endMap));
            float yawErr = (float)Math.abs(Math.toDegrees(loc.yawRadians() - 0.9f));
            assert yawErr < 6 && off < 2.5f : "맵 매칭 오차 시작 " + error + "° -> yaw " + yawErr + "°, 40m 지점 " + off + "m";
            System.out.printf("맵 매칭: 나침반 오차 %+.0f° -> 40m 걷고 yaw 오차 %.1f°, 위치 차 %.2f m%n", error, yawErr, off);
        }
        System.out.println("PASS: 정합 왕복·정문 위경도, 호실 5곳, 메시 법선, ㄱ자 회전(오른쪽 " + Math.round(t.distance) + "m " + Math.round(t.degrees) + "°), 정문→3층 엘베 "
                + Math.round(real.total) + "m 화살표 위치");
    }

    private static boolean inside(float[][] poly, float x, float z) {
        boolean in = false;
        for (int i = 0, j = poly.length - 1; i < poly.length; j = i++)
            if ((poly[i][1] > z) != (poly[j][1] > z) && x < (poly[j][0] - poly[i][0]) * (z - poly[i][1]) / (poly[j][1] - poly[i][1]) + poly[i][0]) in = !in;
        return in;
    }
}

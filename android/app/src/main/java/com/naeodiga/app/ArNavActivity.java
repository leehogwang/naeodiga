package com.naeodiga.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.hardware.GeomagneticField;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.ar.core.Anchor;
import com.google.ar.core.ArCoreApk;
import com.google.ar.core.Config;
import com.google.ar.core.Frame;
import com.google.ar.core.FutureState;
import com.google.ar.core.Pose;
import com.google.ar.core.ResolveCloudAnchorFuture;
import com.google.ar.core.Session;
import com.google.ar.core.TrackingState;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.List;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * 실내 AR 길안내. 지도(assets/nav.json)의 Cloud Anchor를 resolve해서 지도와 지금 세션을 맞추고,
 * 목적지까지 걸었던 경로 위에 3D 화살표를 띄운다. 목적지는 웹 앱이 위경도+층으로 넘겨준다.
 * 위치 추적은 ARCore가 하므로 걸어가면 화살표가 계속 앞쪽 경로 위에 남는다.
 */
public final class ArNavActivity extends Activity implements GLSurfaceView.Renderer, SensorEventListener {
    static final String EXTRA_LAT = "lat", EXTRA_LNG = "lng", EXTRA_FLOOR = "floor", EXTRA_NAME = "name";
    static final String EXTRA_ENT_LAT = "entLat", EXTRA_ENT_LNG = "entLng", EXTRA_ENT_FLOOR = "entFloor";
    static final String RESULT_ARRIVED = "arrived", RESULT_FLOOR = "floor", RESULT_REASON = "reason";
    private static final float ARRIVE_METERS = 2.5f;

    private final Object lock = new Object();
    private final ArRenderer renderer = new ArRenderer();
    private GLSurfaceView surface;
    private TextView status, arrowIcon, distance, place, detail;
    private Button action;
    private View card;
    private Session session;
    private NavMap map;
    private Georef georef;
    private boolean installRequested;
    private volatile boolean resumed;
    private volatile int destination = -1;     // 안내 중인 앵커가 아니라 그래프 노드 번호
    private String destinationName = "";
    private String destinationFloor = "";
    private volatile boolean arrived;
    private volatile String lastFloor = "";
    private int width, height;
    private long lastGuideUi, lastRoute;
    private String lastStatus = "", mode = "";
    private Anchor[] resolved;
    private ResolveCloudAnchorFuture[] futures;
    private long[] retryAt;
    private String[] anchorState;
    private Integer[] order;  // resolve 우선순위: 정문 앵커 먼저
    private static final int MAX_RESOLVING = 4;  // 13개를 한꺼번에 3초마다 다시 요청하면 쿼터(RESOURCE_EXHAUSTED)에 걸릴 수 있어 동시에 4개만
    private NavMap.Alignment alignment;
    // 앵커 없이 입구에서 시작: 입구 노드 위치 + 나침반 방향. 앵커가 인식되면 앵커 정렬이 우선한다
    private int entranceNode = -1;
    private DoorLocalizer localizer;
    private boolean anchorAligned;
    private SensorManager sensors;
    private final float[] rotation = new float[9];
    private volatile boolean compassReady;
    private float declination;
    private String reference = "";
    private int[] path = new int[0];

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        buildUi();
        try {
            map = new NavMap(read("nav.json"));
            georef = new Georef(read("ar_meta.json"));
            int count = map.anchors.length();
            resolved = new Anchor[count];
            futures = new ResolveCloudAnchorFuture[count];
            retryAt = new long[count];
            anchorState = new String[count];
            order = new Integer[count];
            for (int i = 0; i < count; i++) order[i] = i;
            java.util.Arrays.sort(order, (a, b) -> Boolean.compare(!map.anchors.optJSONObject(a).optString("name").contains("정문"),
                    !map.anchors.optJSONObject(b).optString("name").contains("정문")));  // 안정 정렬: 정문 먼저, 나머지는 원래 순서
            long now = System.currentTimeMillis();
            for (int i = 0; i < count; i++) {
                JSONObject anchor = map.anchors.getJSONObject(i);
                anchorState[i] = anchor.getLong("hosted_at_unix_ms") + anchor.getInt("ttl_days") * 86_400_000L < now ? "EXPIRED" : "WAITING";
            }
            Intent in = getIntent();
            destinationName = in.getStringExtra(EXTRA_NAME) == null ? "" : in.getStringExtra(EXTRA_NAME);
            if (in.hasExtra(EXTRA_LAT)) {
                float[] xz = georef.toMap(in.getDoubleExtra(EXTRA_LAT, 0), in.getDoubleExtra(EXTRA_LNG, 0));
                int floor = in.getIntExtra(EXTRA_FLOOR, 0);
                destination = Georef.nodeFor(map, xz[0], xz[1], floor, 25f);
                destinationFloor = destination < 0 ? "" : floor > 0 ? floor + "층" : map.floorOf(map.nodes[destination][1]);
            }
            if (in.hasExtra(EXTRA_ENT_LAT)) {
                double eLat = in.getDoubleExtra(EXTRA_ENT_LAT, 0), eLng = in.getDoubleExtra(EXTRA_ENT_LNG, 0);
                float[] exz = georef.toMap(eLat, eLng);
                entranceNode = Georef.nodeFor(map, exz[0], exz[1], in.getIntExtra(EXTRA_ENT_FLOOR, 1), 25f);
                declination = new GeomagneticField((float)eLat, (float)eLng, 0, System.currentTimeMillis()).getDeclination();
            }
            if (destination < 0) status("목적지를 이 지도에서 찾지 못했어요. 직접 골라 주세요.");
        } catch (Exception e) {
            status("길안내 데이터를 읽지 못했습니다: " + e.getMessage());
        }
    }

    private String read(String asset) throws Exception {
        try (InputStream input = getAssets().open(asset)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[65536];
            for (int size; (size = input.read(buffer)) != -1; ) bytes.write(buffer, 0, size);
            return bytes.toString("UTF-8");
        }
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void buildUi() {
        FrameLayout layout = new FrameLayout(this);
        surface = new GLSurfaceView(this);
        surface.setEGLContextClientVersion(2);
        surface.setPreserveEGLContextOnPause(true);
        surface.setRenderer(this);
        surface.setContentDescription("카메라 화면. 바닥의 화살표를 따라 이동하세요.");
        layout.addView(surface);

        Button back = new Button(this);
        back.setText("‹ 지도");
        back.setTextColor(Color.WHITE);
        back.setBackground(round(0xcc1c1c1e, 22));
        back.setOnClickListener(v -> finishWith("back"));
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(-2, dp(44), Gravity.TOP | Gravity.START);
        bp.setMargins(dp(14), dp(40), 0, 0);
        layout.addView(back, bp);

        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(15);
        status.setBackground(round(0xd91c1c1e, 14));
        status.setPadding(dp(14), dp(10), dp(14), dp(10));
        FrameLayout.LayoutParams sp = new FrameLayout.LayoutParams(-1, -2, Gravity.TOP);
        sp.setMargins(dp(14), dp(96), dp(14), 0);
        layout.addView(status, sp);

        // 아래 카드: 가는 방향 화살표 + 남은 거리 + 목적지
        arrowIcon = new TextView(this);
        arrowIcon.setText("↑");
        arrowIcon.setTextColor(Color.WHITE);
        arrowIcon.setTextSize(40);
        arrowIcon.setGravity(Gravity.CENTER);
        distance = new TextView(this);
        distance.setTextColor(Color.WHITE);
        distance.setTextSize(26);
        distance.setTypeface(null, android.graphics.Typeface.BOLD);
        place = new TextView(this);
        place.setTextColor(Color.WHITE);
        place.setTextSize(16);
        detail = new TextView(this);
        detail.setTextColor(0xffb0b4bb);
        detail.setTextSize(13);
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.addView(distance);
        texts.addView(place);
        texts.addView(detail);
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(arrowIcon, new LinearLayout.LayoutParams(dp(64), dp(64)));
        row.addView(texts, new LinearLayout.LayoutParams(0, -2, 1));
        action = new Button(this);
        action.setVisibility(View.GONE);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(16), dp(12), dp(16), dp(12));
        box.setBackground(round(0xee1c1c1e, 22));
        box.addView(row);
        box.addView(action);
        card = box;
        card.setVisibility(View.GONE);
        FrameLayout.LayoutParams cp = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        cp.setMargins(dp(14), 0, dp(14), dp(28));
        layout.addView(card, cp);
        setContentView(layout);
        status("준비 중");
    }

    private static GradientDrawable round(int color, int radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(radiusDp * 3);
        return g;
    }

    private void chooseDestination() {
        if (map == null) return;
        // 같은 이름을 두 번 찍은 앵커(예: 다시 둔 계단)는 목적지 하나로
        java.util.LinkedHashMap<String, Integer> unique = new java.util.LinkedHashMap<>();
        for (int i = 0; i < map.anchors.length(); i++) {
            JSONObject anchor = map.anchors.optJSONObject(i);
            unique.putIfAbsent(anchor.optString("name") + " · " + anchor.optString("floor"), i);
        }
        String[] labels = unique.keySet().toArray(new String[0]);
        Integer[] targets = unique.values().toArray(new Integer[0]);
        new AlertDialog.Builder(this).setTitle("어디로 갈까요?")
                .setItems(labels, (dialog, which) -> {
                    JSONObject a = map.anchors.optJSONObject(targets[which]);
                    destinationName = a.optString("name");
                    destinationFloor = a.optString("floor");
                    arrived = false;
                    lastRoute = 0;
                    destination = a.optInt("node");
                }).setNegativeButton("닫기", null).show();
    }

    private void finishWith(String reason) {
        Intent out = new Intent();
        out.putExtra(RESULT_REASON, reason);
        out.putExtra(RESULT_ARRIVED, arrived);
        out.putExtra(RESULT_FLOOR, floorNumber(lastFloor));
        setResult(RESULT_OK, out);
        finish();
    }

    @Override public void onBackPressed() { finishWith("back"); }

    @Override protected void onResume() {
        super.onResume();
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, 1);
            return;
        }
        try {
            if (session == null) {
                if (ArCoreApk.getInstance().requestInstall(this, !installRequested) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                    installRequested = true;
                    return;
                }
                session = new Session(this);
                Config config = new Config(session);
                config.setCloudAnchorMode(Config.CloudAnchorMode.ENABLED);
                config.setFocusMode(Config.FocusMode.AUTO);
                session.configure(config);
            }
            session.resume();
            sensors = (SensorManager)getSystemService(SENSOR_SERVICE);
            Sensor rv = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
            if (rv != null) sensors.registerListener(this, rv, SensorManager.SENSOR_DELAY_GAME);
            resumed = true;
            surface.onResume();
        } catch (Exception e) {
            status("AR 시작 실패: " + e.getMessage());
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED) status("길안내에는 카메라 권한이 필요합니다.");
    }

    @Override public void onSensorChanged(SensorEvent event) {
        synchronized (rotation) { SensorManager.getRotationMatrixFromVector(rotation, event.values); compassReady = true; }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    /** 카메라가 보는 방향의 진북 기준 방위각(도). 나침반이 아직 없거나 폰이 위·아래를 보고 있으면 NaN. */
    private double cameraBearing() {
        if (!compassReady) return Double.NaN;
        double east, north;
        synchronized (rotation) { east = -rotation[2]; north = -rotation[5]; }  // 기기 -Z(카메라 방향)의 동·북 성분
        if (Math.hypot(east, north) < .5) return Double.NaN;
        return Math.toDegrees(Math.atan2(east, north)) + declination;
    }

    @Override protected void onPause() {
        if (sensors != null) sensors.unregisterListener(this);
        resumed = false;
        surface.onPause();
        synchronized (lock) { if (session != null) session.pause(); }
        super.onPause();
    }

    @Override protected void onDestroy() {
        synchronized (lock) {
            if (futures != null) for (ResolveCloudAnchorFuture future : futures) if (future != null) future.cancel();
            if (session != null) { session.close(); session = null; }
        }
        super.onDestroy();
    }

    @Override public void onSurfaceCreated(GL10 gl, EGLConfig config) { renderer.create(); }
    @Override public void onSurfaceChanged(GL10 gl, int w, int h) { width = w; height = h; GLES20.glViewport(0, 0, w, h); }

    @Override public void onDrawFrame(GL10 gl) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT | GLES20.GL_DEPTH_BUFFER_BIT);
        synchronized (lock) {
            if (!resumed || session == null || width == 0 || map == null) return;
            try {
                session.setCameraTextureName(renderer.texture);
                session.setDisplayGeometry(getWindowManager().getDefaultDisplay().getRotation(), width, height);
                Frame frame = session.update();
                renderer.draw(frame);
                if (frame.getCamera().getTrackingState() != TrackingState.TRACKING) {
                    status("주변을 인식하는 중… 휴대폰을 천천히 움직여 주세요.");
                    showCard(false);
                    return;
                }
                resolveAnchors();
                Pose camera = frame.getCamera().getPose();
                if (!align(camera)) {
                    if (entranceNode >= 0) {  // 앵커 없이 입구에서 시작하는 중: 나침반 방향이 잡힐 때까지
                        status("입구 앞에서 휴대폰을 정면으로 들고 앞을 바라봐 주세요.\n나침반 확인 중 (∞ 모양으로 흔들면 정확해져요)");
                        showCard(false);
                        return;
                    }
                    int found = 0, alive = 0;
                    for (String state : anchorState) {
                        if ("SUCCESS".equals(state)) found++;
                        if (!"EXPIRED".equals(state)) alive++;
                    }
                    status(alive == 0 ? "이 건물의 앵커가 모두 만료되었습니다. 앵커를 다시 수집해야 합니다."
                            : "위치 찾는 중 · 정문·엘리베이터·계단 같은 앵커 근처를 천천히 비춰 주세요.\n인식 " + found + " / " + alive + "\n" + anchorSummary()
                            + (anchorSummary().contains("NOT_AUTHORIZED") ? "\nAPI 키 인증 실패: 키 제한에 com.naeodiga.app 과 이 앱 SHA-1 허용이 필요해요" : ""));
                    showCard(false);
                    return;
                }
                guide(camera);
            } catch (Exception e) {
                status("오류: " + e.getClass().getSimpleName() + " " + e.getMessage());
            }
        }
    }

    private void resolveAnchors() throws Exception {
        long now = SystemClock.elapsedRealtime();
        int running = 0;
        for (ResolveCloudAnchorFuture f : futures) if (f != null) running++;
        for (int i : order) {
            if ("EXPIRED".equals(anchorState[i]) || "SUCCESS".equals(anchorState[i])) continue;
            if (futures[i] == null) {
                if (now < retryAt[i] || running >= MAX_RESOLVING) continue;
                futures[i] = session.resolveCloudAnchorAsync(map.anchors.getJSONObject(i).getString("cloud_anchor_id"), null);
                anchorState[i] = "RESOLVING";
                running++;
            } else if (futures[i].getState() == FutureState.DONE) {
                Anchor.CloudAnchorState result = futures[i].getResultCloudAnchorState();
                Log.i("ArNav", "resolve " + map.anchors.getJSONObject(i).getString("name") + " -> " + result);
                if (result == Anchor.CloudAnchorState.SUCCESS) {
                    resolved[i] = futures[i].getResultAnchor();
                    anchorState[i] = "SUCCESS";
                } else {
                    anchorState[i] = result == Anchor.CloudAnchorState.ERROR_CLOUD_ID_NOT_FOUND ? "EXPIRED" : result.name();
                    retryAt[i] = now + 5_000;  // 아직 못 봤거나 네트워크 문제: 둘러보는 동안 다시 시도
                }
                futures[i] = null;
                running--;
            }
        }
    }

    /** 앵커별 상태를 개수로 묶어서 화면에 보여 준다 (예: "NOT_AUTHORIZED ×13"). 안 뜨는 이유를 현장에서 바로 알 수 있게. */
    private String anchorSummary() {
        java.util.TreeMap<String, Integer> counts = new java.util.TreeMap<>();
        for (String state : anchorState) counts.merge(state.replace("ERROR_", ""), 1, Integer::sum);
        StringBuilder out = new StringBuilder();
        for (java.util.Map.Entry<String, Integer> e : counts.entrySet()) out.append(out.length() == 0 ? "" : ", ").append(e.getKey()).append(" ×").append(e.getValue());
        return out.toString();
    }

    /**
     * 인식된 앵커 중 카메라에서 가장 가까운 것으로 지도-세션을 다시 맞춘다. 앵커가 하나도 인식 안 됐으면
     * 입구에서 시작한 DoorLocalizer 정렬을 쓴다. 둘 다 없으면 false.
     */
    private boolean align(Pose camera) throws Exception {
        int best = -1;
        float bestDistance = Float.MAX_VALUE;
        for (int i = 0; i < resolved.length; i++) {
            if (resolved[i] == null || resolved[i].getTrackingState() != TrackingState.TRACKING) continue;
            float d = NavMap.distance(resolved[i].getPose().getTranslation(), camera.getTranslation());
            if (d < bestDistance) { bestDistance = d; best = i; }
        }
        if (best >= 0) {
            Pose pose = resolved[best].getPose();
            alignment = NavMap.Alignment.fromAnchor(map.anchors.getJSONObject(best).getJSONArray("pose"), pose.getTranslation(), pose.getZAxis());
            reference = map.anchors.getJSONObject(best).getString("name") + " 기준";
            anchorAligned = true;
            return true;
        }
        if (anchorAligned) return true;  // 앵커가 잠깐 안 보여도 마지막 정렬 유지
        if (localizer == null && entranceNode >= 0) {
            double bearing = cameraBearing();
            if (Double.isNaN(bearing)) return false;  // 휴대폰을 앞으로 들어 달라고 안내
            float[] forward = {-camera.getZAxis()[0], -camera.getZAxis()[2]};
            if (Math.hypot(forward[0], forward[1]) < .5) return false;
            float[] dir = georef.directionToMap(bearing);
            localizer = new DoorLocalizer(map.nodes[entranceNode], camera.getTranslation(),
                    NavMap.yaw(forward[0], forward[1]), NavMap.yaw(dir[0], dir[1]));
        }
        if (localizer == null) return false;
        alignment = localizer.alignment();
        reference = "입구 위치 기준";
        return true;
    }

    private void guide(Pose camera) {
        float[] cam = camera.getTranslation();
        float[] here = alignment.toMap(cam);
        String hereFloor = map.floorOf(here[1]);
        lastFloor = hereFloor;
        int goalNode = destination;
        if (goalNode < 0) {
            status("위치 확인 완료 · 현재 " + hereFloor + " · " + reference);
            if (!mode.equals("choose")) { mode = "choose"; setAction("목적지 선택", this::chooseDestination); }
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (now - lastRoute > 1_000) { path = map.shortestPath(map.nearest(here), goalNode); lastRoute = now; }
        if (path.length == 0) { status("경로를 찾지 못했습니다."); showCard(false); return; }

        if (localizer != null && !anchorAligned) {
            // 걸어온 방향을 경로 방향에 맞춰 나침반 오차를 줄인다 (경로는 지도 좌표 기준)
            Guidance routeMap = new Guidance(Guidance.toFloorRoute(map, path, new NavMap.Alignment(new float[3], 0, new float[3], 0)));
            if (localizer.refine(cam, routeMap) != 0) alignment = localizer.alignment();
        }
        Guidance g = new Guidance(Guidance.toFloorRoute(map, path, alignment));
        float s0 = g.progress(cam), remaining = Math.max(0, g.total - s0);
        float flat = (float)Math.hypot(here[0] - map.nodes[goalNode][0], here[2] - map.nodes[goalNode][2]);
        boolean sameFloor = hereFloor.equals(destinationFloor);
        if (sameFloor && flat < ARRIVE_METERS) arrived = true;

        // 화살표: 앞쪽 경로 위에 1m 간격, 위아래로 천천히 출렁이며 앞으로 흘러가는 느낌
        float time = (now % 4000) / 4000f;
        List<Guidance.Arrow> arrows = g.arrows(s0, 1.4f, 1.0f, 9f);
        for (int i = 0; i < arrows.size(); i++) {
            Guidance.Arrow a = arrows.get(i);
            float pulse = (float)Math.sin(2 * Math.PI * (time * 2 - i * .18f));
            renderer.arrow(a.x, a.y + .04f + .025f * pulse, a.z, a.yaw, 1f, .95f - .05f * i);
        }
        float[] end = alignment.toUser(map.nodes[goalNode]);
        end[1] -= Guidance.CAMERA_HEIGHT;
        if (g.total - s0 < 15) renderer.points(end, 1, .2f, 1f, .3f, 700f);

        // 휴대폰이 보는 방향 기준으로 갈 방향 (화살표 아이콘 회전)
        float[] ahead = g.pointAt(s0 + 2.5f);
        float[] forward = {-camera.getZAxis()[0], -camera.getZAxis()[2]};
        if (Math.hypot(forward[0], forward[1]) < .25) forward = new float[]{camera.getYAxis()[0], camera.getYAxis()[2]};  // 바닥을 보고 있을 때는 폰 윗변 방향
        float turnToPath = Guidance.relativeDegrees(forward[0], forward[1], ahead[0] - cam[0], ahead[2] - cam[2]);
        Guidance.Turn turn = g.nextTurn(s0, 50);
        showGuidance(hereFloor, sameFloor, remaining, turnToPath, turn);
    }

    private void showGuidance(String hereFloor, boolean sameFloor, float remaining, float turnToPath, Guidance.Turn turn) {
        long now = SystemClock.elapsedRealtime();
        if (now - lastGuideUi < 150) return;
        lastGuideUi = now;
        mode = "guide";
        final boolean done = arrived;
        final String instruction;
        if (done) instruction = "도착했어요";
        else if (!sameFloor) instruction = "계단으로 " + destinationFloor + " " + (floorNumber(destinationFloor) > floorNumber(hereFloor) ? "올라가세요" : "내려가세요");
        else if (Math.abs(turnToPath) > 100) instruction = "뒤로 돌아 가세요";
        else if (Math.abs(turnToPath) > 35) instruction = turnToPath > 0 ? "오른쪽으로 도세요" : "왼쪽으로 도세요";
        else if (turn != null) instruction = Math.round(turn.distance) + "m 앞에서 " + (turn.degrees > 0 ? "오른쪽" : "왼쪽") + "으로 도세요";
        else instruction = "직진하세요";
        final String meters = done ? "도착" : Math.round(remaining) + "m";
        final String where = destinationName.isEmpty() ? destinationFloor : destinationName + " (" + destinationFloor + ")";
        runOnUiThread(() -> {
            status.setVisibility(View.GONE);
            lastStatus = "";
            arrowIcon.setText(done ? "✓" : "↑");
            arrowIcon.setRotation(done ? 0 : turnToPath);
            distance.setText(meters);
            place.setText(instruction);
            detail.setText(where + " · 현재 " + hereFloor + " · " + reference);
            card.setVisibility(View.VISIBLE);
            if (done) setAction("다 왔어요", () -> finishWith("arrived"));
            else if (action.getVisibility() == View.VISIBLE) action.setVisibility(View.GONE);
        });
    }

    private static int floorNumber(String name) {
        try { return Integer.parseInt(name.replace("층", "")); } catch (NumberFormatException e) { return 0; }
    }

    private void setAction(String text, Runnable run) {
        runOnUiThread(() -> { action.setText(text); action.setOnClickListener(v -> run.run()); action.setVisibility(View.VISIBLE); card.setVisibility(View.VISIBLE); distance.setText(""); place.setText(""); detail.setText(""); });
    }

    private void showCard(boolean visible) {
        if (!visible && mode.isEmpty()) return;
        if (!visible) mode = "";
        runOnUiThread(() -> card.setVisibility(visible ? View.VISIBLE : View.GONE));
    }

    private void status(String text) {
        if (text.equals(lastStatus)) return;
        lastStatus = text;
        runOnUiThread(() -> { status.setText(text); status.setVisibility(text.isEmpty() ? View.GONE : View.VISIBLE); });
    }
}

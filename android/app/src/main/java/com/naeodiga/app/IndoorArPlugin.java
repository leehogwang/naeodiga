package com.naeodiga.app;

import android.app.Activity;
import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.ar.core.ArCoreApk;

import org.json.JSONArray;

import java.io.InputStream;

/**
 * 웹 앱 <-> 실내 AR 길안내 화면(ArNavActivity).
 *   isAvailable({code})                      -> { available, reason? }  이 건물 AR 지도가 있고 ARCore를 쓸 수 있나
 *   start({lat, lng, floor, name, entLat, entLng, entFloor}) -> { arrived, floor, reason }  AR 화면이 닫힐 때 resolve
 *     ent*: 입구 위치. 있으면 앵커 없이 "지금 입구 앞"으로 보고 나침반+걸음으로 정렬
 */
@CapacitorPlugin(name = "IndoorAr")
public class IndoorArPlugin extends Plugin {
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        try {
            String code = call.getString("code", "");
            boolean covered = false;
            try (InputStream in = getContext().getAssets().open("ar_meta.json")) {
                java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                for (int n; (n = in.read(buffer)) != -1; ) bytes.write(buffer, 0, n);  // InputStream.readAllBytes는 API 33부터라 직접 읽음
                JSONArray buildings = new org.json.JSONObject(bytes.toString("UTF-8")).getJSONArray("buildings");
                for (int i = 0; i < buildings.length(); i++) if (buildings.getString(i).equals(code)) covered = true;
            }
            if (!covered) { r.put("available", false); r.put("reason", "no-map"); call.resolve(r); return; }
            ArCoreApk.Availability a = ArCoreApk.getInstance().checkAvailability(getContext());
            // 아직 확인 중이거나 설치만 필요한 상태(SUPPORTED_NOT_INSTALLED)는 AR 화면에서 설치를 안내하므로 사용 가능으로 본다
            boolean ok = a.isSupported() || a.isTransient();
            r.put("available", ok);
            if (!ok) r.put("reason", "arcore-unsupported");
        } catch (Exception e) {
            r.put("available", false);
            r.put("reason", "error: " + e.getMessage());
        }
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), ArNavActivity.class);
        if (call.hasOption("lat") && call.hasOption("lng")) {
            intent.putExtra(ArNavActivity.EXTRA_LAT, call.getDouble("lat", 0.0));
            intent.putExtra(ArNavActivity.EXTRA_LNG, call.getDouble("lng", 0.0));
        }
        if (call.hasOption("entLat") && call.hasOption("entLng")) {  // 입구 위치: 앵커 없이 여기서 시작한 걸로 보고 정렬
            intent.putExtra(ArNavActivity.EXTRA_ENT_LAT, call.getDouble("entLat", 0.0));
            intent.putExtra(ArNavActivity.EXTRA_ENT_LNG, call.getDouble("entLng", 0.0));
            intent.putExtra(ArNavActivity.EXTRA_ENT_FLOOR, call.getInt("entFloor", 1));
        }
        intent.putExtra(ArNavActivity.EXTRA_FLOOR, call.getInt("floor", 0));
        intent.putExtra(ArNavActivity.EXTRA_NAME, call.getString("name", ""));
        startActivityForResult(call, intent, "arClosed");
    }

    @ActivityCallback
    private void arClosed(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject();
        Intent data = result.getData();
        r.put("arrived", data != null && data.getBooleanExtra(ArNavActivity.RESULT_ARRIVED, false));
        r.put("floor", data == null ? 0 : data.getIntExtra(ArNavActivity.RESULT_FLOOR, 0));
        r.put("reason", result.getResultCode() == Activity.RESULT_OK && data != null ? data.getStringExtra(ArNavActivity.RESULT_REASON) : "closed");
        call.resolve(r);
    }
}

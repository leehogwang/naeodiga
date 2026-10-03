package com.naeodiga.app;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// 휴대폰 기압계(TYPE_PRESSURE) 값을 웹 쪽에 'pressure' 이벤트로 보냄
@CapacitorPlugin(name = "Barometer")
public class BarometerPlugin extends Plugin implements SensorEventListener {
    private SensorManager sm;
    private Sensor sensor;

    @Override
    public void load() {
        sm = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        sensor = sm.getDefaultSensor(Sensor.TYPE_PRESSURE);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", sensor != null);
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (sensor == null) { call.reject("이 휴대폰에는 기압계가 없어요"); return; }
        sm.unregisterListener(this);
        sm.registerListener(this, sensor, SensorManager.SENSOR_DELAY_UI);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        sm.unregisterListener(this);
        call.resolve();
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        JSObject r = new JSObject();
        r.put("hPa", e.values[0]);
        r.put("t", System.currentTimeMillis());
        notifyListeners("pressure", r);
    }

    @Override
    public void onAccuracyChanged(Sensor s, int accuracy) {}

    // 앱이 백그라운드로 가면 센서를 꺼서 배터리 절약, 돌아오면 다시 켬
    @Override
    protected void handleOnPause() { if (sm != null) sm.unregisterListener(this); }

    @Override
    protected void handleOnResume() {
        if (sensor != null && hasListeners("pressure")) sm.registerListener(this, sensor, SensorManager.SENSOR_DELAY_UI);
    }
}

package com.naeodiga.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BarometerPlugin.class); // super.onCreate 전에 등록해야 함
        registerPlugin(IndoorArPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

package dev.itsz.roadlens;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RoadLensUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

package dev.itsz.roadlens;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.TransportInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "RoadLensNetwork")
public class RoadLensNetworkPlugin extends Plugin {
    @PluginMethod
    public void getWifiInfo(PluginCall call) {
        JSObject result = new JSObject();
        result.put("connected", false);
        result.put("locationPermission", hasLocationPermission());

        try {
            ConnectivityManager connectivityManager =
                (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            Network activeNetwork = connectivityManager == null ? null : connectivityManager.getActiveNetwork();
            NetworkCapabilities capabilities = activeNetwork == null
                ? null
                : connectivityManager.getNetworkCapabilities(activeNetwork);
            boolean connected = capabilities != null &&
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
            result.put("connected", connected);

            String ssid = connected ? currentSsid(capabilities) : null;
            if (ssid != null && !ssid.trim().isEmpty()) {
                result.put("ssid", ssid);
            }

            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void openWifiSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_WIFI_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    private String currentSsid(NetworkCapabilities capabilities) {
        String ssid = null;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && capabilities != null) {
            TransportInfo transportInfo = capabilities.getTransportInfo();
            if (transportInfo instanceof WifiInfo) {
                ssid = ((WifiInfo) transportInfo).getSSID();
            }
        }

        if (ssid == null) {
            WifiManager wifiManager =
                (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiInfo connectionInfo = wifiManager == null ? null : wifiManager.getConnectionInfo();
            ssid = connectionInfo == null ? null : connectionInfo.getSSID();
        }

        return cleanSsid(ssid);
    }

    private String cleanSsid(String ssid) {
        if (ssid == null) {
            return null;
        }
        String cleaned = ssid.trim();
        if (cleaned.equalsIgnoreCase("<unknown ssid>") || cleaned.equals("0x")) {
            return null;
        }
        if (cleaned.length() >= 2 && cleaned.startsWith("\"") && cleaned.endsWith("\"")) {
            cleaned = cleaned.substring(1, cleaned.length() - 1);
        }
        return cleaned;
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED;
    }
}

package dev.itsz.roadlens;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.net.Uri;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Locale;

@CapacitorPlugin(name = "RoadLensUsb")
public class RoadLensUsbPlugin extends Plugin {
    private static final String ACTION_USB_PERMISSION = "dev.itsz.roadlens.USB_PERMISSION";

    private PluginCall pendingPermissionCall;
    private int pendingPermissionDeviceId = -1;
    private BroadcastReceiver permissionReceiver;

    @PluginMethod
    public void listDevices(PluginCall call) {
        JSObject result = new JSObject();
        result.put("devices", buildDeviceList());
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        Integer deviceId = call.getInt("deviceId");
        if (deviceId == null) {
            call.reject("Missing USB device id");
            return;
        }

        UsbManager manager = getUsbManager();
        UsbDevice device = findDeviceById(deviceId);
        if (device == null) {
            call.reject("USB device is no longer connected");
            return;
        }

        if (manager.hasPermission(device)) {
            resolvePermission(call, true, device);
            return;
        }

        if (pendingPermissionCall != null) {
            call.reject("Another USB permission request is already active");
            return;
        }

        pendingPermissionCall = call;
        pendingPermissionDeviceId = deviceId;
        registerPermissionReceiver();

        Intent intent = new Intent(ACTION_USB_PERMISSION);
        intent.setPackage(getContext().getPackageName());
        PendingIntent permissionIntent = PendingIntent.getBroadcast(
            getContext(),
            deviceId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        manager.requestPermission(device, permissionIntent);
    }

    @PluginMethod
    public void openFlasher(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("Missing flasher URL");
            return;
        }

        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void flashBundledFirmware(PluginCall call) {
        Integer deviceId = call.getInt("deviceId");
        String requestedChipFamily = call.getString("chipFamily");
        if (deviceId == null) {
            call.reject("Missing USB device id");
            return;
        }

        UsbManager manager = getUsbManager();
        UsbDevice device = findDeviceById(deviceId);
        if (device == null) {
            call.reject("USB device is no longer connected");
            return;
        }
        if (!manager.hasPermission(device)) {
            call.reject("USB permission is missing. Tap Detect, approve the USB prompt, then Flash again.");
            return;
        }
        if (!profileFor(device).supported) {
            call.reject("This USB device is not a supported ESP32 serial adapter");
            return;
        }

        new Thread(() -> {
            try {
                RoadLensEspFlasher flasher = new RoadLensEspFlasher(
                    manager,
                    device,
                    path -> getContext().getAssets().open(path),
                    this::notifyFlashProgress
                );
                RoadLensEspFlasher.FlashResult flashResult = flasher.flashBundled(requestedChipFamily);

                JSObject result = new JSObject();
                result.put("chipFamily", flashResult.chipFamily);
                result.put("version", flashResult.version);
                result.put("parts", flashResult.parts);
                result.put("bytes", flashResult.bytes);
                getActivity().runOnUiThread(() -> call.resolve(result));
            } catch (Exception error) {
                getActivity().runOnUiThread(() -> call.reject(error.getMessage(), error));
            }
        }).start();
    }

    private JSArray buildDeviceList() {
        JSArray devices = new JSArray();
        UsbManager manager = getUsbManager();
        HashMap<String, UsbDevice> deviceMap = manager.getDeviceList();

        for (UsbDevice device : deviceMap.values()) {
            devices.put(buildDeviceInfo(device, manager.hasPermission(device)));
        }

        return devices;
    }

    private void notifyFlashProgress(String stage, String detail, int progress, long bytes, long totalBytes) {
        JSObject event = new JSObject();
        event.put("stage", stage);
        event.put("detail", detail);
        event.put("progress", progress);
        event.put("bytes", bytes);
        event.put("totalBytes", totalBytes);
        getActivity().runOnUiThread(() -> notifyListeners("usbFlashProgress", event));
    }

    private JSObject buildDeviceInfo(UsbDevice device, boolean permissionGranted) {
        DeviceProfile profile = profileFor(device);
        JSObject info = new JSObject();
        info.put("deviceId", device.getDeviceId());
        info.put("vendorId", device.getVendorId());
        info.put("productId", device.getProductId());
        info.put("deviceName", device.getDeviceName());
        info.put("label", profile.label);
        info.put("driverHint", profile.driverHint);
        info.put("supported", profile.supported);
        info.put("permissionGranted", permissionGranted);
        if (profile.chipFamily != null) {
            info.put("chipFamily", profile.chipFamily);
        }

        if (permissionGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            putIfPresent(info, "manufacturerName", safeManufacturerName(device));
            putIfPresent(info, "productName", safeProductName(device));
            putIfPresent(info, "serialNumber", safeSerialNumber(device));
        }

        return info;
    }

    private DeviceProfile profileFor(UsbDevice device) {
        int vendorId = device.getVendorId();
        int productId = device.getProductId();

        if (vendorId == 0x303A) {
            return new DeviceProfile("Espressif native USB", "espusb", true, chipFamilyForEspressifProduct(productId));
        }
        if (vendorId == 0x10C4 && productId == 0xEA60) {
            return new DeviceProfile("ESP32 CP210x bridge", "cp210x", true, "ESP32");
        }
        if (vendorId == 0x1A86) {
            return new DeviceProfile("ESP32 CH34x bridge", "ch34x", true, "ESP32");
        }
        if (vendorId == 0x0403) {
            return new DeviceProfile("ESP32 FTDI bridge", "ftdi", true, "ESP32");
        }

        return new DeviceProfile(
            String.format(Locale.US, "USB %04X:%04X", vendorId, productId),
            "unknown",
            false,
            null
        );
    }

    private String chipFamilyForEspressifProduct(int productId) {
        switch (productId) {
            case 0x1001:
            case 0x1002:
                return "ESP32-S3";
            case 0x1003:
            case 0x1004:
                return "ESP32-C3";
            default:
                return null;
        }
    }

    private void putIfPresent(JSObject info, String key, String value) {
        if (value != null && !value.trim().isEmpty()) {
            info.put(key, value);
        }
    }

    private String safeManufacturerName(UsbDevice device) {
        try {
            return device.getManufacturerName();
        } catch (SecurityException ignored) {
            return null;
        }
    }

    private String safeProductName(UsbDevice device) {
        try {
            return device.getProductName();
        } catch (SecurityException ignored) {
            return null;
        }
    }

    private String safeSerialNumber(UsbDevice device) {
        try {
            return device.getSerialNumber();
        } catch (SecurityException ignored) {
            return null;
        }
    }

    private UsbManager getUsbManager() {
        return (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
    }

    private UsbDevice findDeviceById(int deviceId) {
        for (UsbDevice device : getUsbManager().getDeviceList().values()) {
            if (device.getDeviceId() == deviceId) {
                return device;
            }
        }
        return null;
    }

    private void registerPermissionReceiver() {
        if (permissionReceiver != null) {
            return;
        }

        permissionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!ACTION_USB_PERMISSION.equals(intent.getAction())) {
                    return;
                }

                UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                PluginCall call = pendingPermissionCall;
                int expectedDeviceId = pendingPermissionDeviceId;

                clearPendingPermission();

                if (call == null) {
                    return;
                }
                if (device == null || device.getDeviceId() != expectedDeviceId) {
                    call.reject("USB permission response did not match the selected device");
                    return;
                }

                resolvePermission(call, granted, device);
            }
        };

        IntentFilter filter = new IntentFilter(ACTION_USB_PERMISSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(permissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(permissionReceiver, filter);
        }
    }

    private void resolvePermission(PluginCall call, boolean granted, UsbDevice device) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        result.put("device", buildDeviceInfo(device, granted));
        call.resolve(result);
    }

    private void clearPendingPermission() {
        if (permissionReceiver != null) {
            try {
                getContext().unregisterReceiver(permissionReceiver);
            } catch (IllegalArgumentException ignored) {
                // Receiver may already be gone if Android tears down the request.
            }
            permissionReceiver = null;
        }
        pendingPermissionCall = null;
        pendingPermissionDeviceId = -1;
    }

    @Override
    protected void handleOnDestroy() {
        clearPendingPermission();
        super.handleOnDestroy();
    }

    private static class DeviceProfile {
        final String label;
        final String driverHint;
        final boolean supported;
        final String chipFamily;

        DeviceProfile(String label, String driverHint, boolean supported, String chipFamily) {
            this.label = label;
            this.driverHint = driverHint;
            this.supported = supported;
            this.chipFamily = chipFamily;
        }
    }
}

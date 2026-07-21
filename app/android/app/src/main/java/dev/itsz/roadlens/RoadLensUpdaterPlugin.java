package dev.itsz.roadlens;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

@CapacitorPlugin(name = "RoadLensUpdater")
public class RoadLensUpdaterPlugin extends Plugin {
    private static final int MAX_APK_BYTES = 250 * 1024 * 1024;

    @PluginMethod
    public void canInstallPackages(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", canRequestPackageInstalls());
        call.resolve(result);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            getActivity().startActivity(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        String fileName = sanitizeFileName(call.getString("fileName", "roadlens-update.apk"));
        String expectedSha256 = call.getString("expectedSha256", "").trim().toLowerCase(Locale.US);
        long expectedBytes = call.getLong("expectedBytes", 0L);
        if (url == null || url.trim().isEmpty()) {
            call.reject("Missing update URL");
            return;
        }
        if (!fileName.toLowerCase(Locale.US).endsWith(".apk")) {
            fileName = fileName + ".apk";
        }
        if (!expectedSha256.matches("[0-9a-f]{64}") || expectedBytes <= 0 || expectedBytes > MAX_APK_BYTES) {
            call.reject("Update manifest verification data is invalid");
            return;
        }
        if (!canRequestPackageInstalls()) {
            call.reject("Install permission is not granted");
            return;
        }

        final String finalFileName = fileName;
        new Thread(() -> {
            try {
                File updatesDir = new File(getContext().getCacheDir(), "updates");
                if (!updatesDir.exists() && !updatesDir.mkdirs()) {
                    throw new IllegalStateException("Could not create update cache");
                }

                File apkFile = new File(updatesDir, finalFileName);
                long bytes = downloadApk(url, apkFile, expectedSha256, expectedBytes);
                openInstaller(apkFile);

                JSObject result = new JSObject();
                result.put("fileName", finalFileName);
                result.put("bytes", bytes);
                getActivity().runOnUiThread(() -> call.resolve(result));
            } catch (Exception error) {
                getActivity().runOnUiThread(() -> call.reject(error.getMessage(), error));
            }
        }).start();
    }

    private boolean canRequestPackageInstalls() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            getContext().getPackageManager().canRequestPackageInstalls();
    }

    private long downloadApk(String sourceUrl, File outputFile, String expectedSha256, long expectedBytes) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(sourceUrl).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(45000);
        connection.setRequestProperty("User-Agent", "RoadLensScout");
        connection.setInstanceFollowRedirects(true);

        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("Download failed with HTTP " + status);
        }

        long total = 0;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[8192];
        try (
            InputStream input = connection.getInputStream();
            FileOutputStream output = new FileOutputStream(outputFile, false)
        ) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_APK_BYTES || total > expectedBytes) {
                    throw new IllegalStateException("APK size does not match the update manifest");
                }
                digest.update(buffer, 0, read);
                output.write(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }

        if (total != expectedBytes) throw new IllegalStateException("APK size does not match the update manifest");
        String actualSha256 = hex(digest.digest());
        if (!MessageDigest.isEqual(actualSha256.getBytes(), expectedSha256.getBytes())) {
            outputFile.delete();
            throw new IllegalStateException("APK SHA-256 verification failed");
        }
        return total;
    }

    private String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) value.append(String.format(Locale.US, "%02x", item));
        return value.toString();
    }

    private void openInstaller(File apkFile) {
        Uri apkUri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            apkFile
        );
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
    }

    private String sanitizeFileName(String value) {
        String cleaned = value.replaceAll("[^A-Za-z0-9._-]", "_");
        return cleaned.isEmpty() ? "roadlens-update.apk" : cleaned;
    }
}

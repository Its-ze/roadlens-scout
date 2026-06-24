package dev.itsz.roadlens;

import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;

import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

class RoadLensEspFlasher {
    interface ProgressCallback {
        void onProgress(String stage, String detail, int progress, long bytes, long totalBytes);
    }

    static class FlashResult {
        final String chipFamily;
        final String version;
        final int parts;
        final long bytes;

        FlashResult(String chipFamily, String version, int parts, long bytes) {
            this.chipFamily = chipFamily;
            this.version = version;
            this.parts = parts;
            this.bytes = bytes;
        }
    }

    private static final int DEFAULT_BAUD = 115200;
    private static final int BLOCK_SIZE = 0x400;
    private static final int USB_TIMEOUT_MS = 5000;
    private static final int SLIP_END = 0xC0;
    private static final int SLIP_ESC = 0xDB;
    private static final int SLIP_ESC_END = 0xDC;
    private static final int SLIP_ESC_ESC = 0xDD;
    private static final int ESP_FLASH_BEGIN = 0x02;
    private static final int ESP_FLASH_DATA = 0x03;
    private static final int ESP_FLASH_END = 0x04;
    private static final int ESP_SYNC = 0x08;

    private final UsbManager usbManager;
    private final UsbDevice device;
    private final InputProvider inputProvider;
    private final ProgressCallback progress;
    private UsbSerialPort port;
    private UsbDeviceConnection connection;

    RoadLensEspFlasher(
        UsbManager usbManager,
        UsbDevice device,
        InputProvider inputProvider,
        ProgressCallback progress
    ) {
        this.usbManager = usbManager;
        this.device = device;
        this.inputProvider = inputProvider;
        this.progress = progress;
    }

    FlashResult flashBundled(String requestedChipFamily) throws Exception {
        FirmwareBundle bundle = FirmwareBundle.load(inputProvider, requestedChipFamily);
        long written = 0;
        long total = bundle.totalBytes();

        openSerial();
        try {
            emit("USB open", deviceLabel(), 1, 0, total);
            syncBootloader();
            emit("Bootloader ready", bundle.chipFamily, 4, 0, total);

            for (FirmwarePart part : bundle.parts) {
                flashBegin(part);
                for (int offset = 0, sequence = 0; offset < part.data.length; offset += BLOCK_SIZE, sequence++) {
                    int remaining = Math.min(BLOCK_SIZE, part.data.length - offset);
                    byte[] block = new byte[BLOCK_SIZE];
                    Arrays.fill(block, (byte) 0xFF);
                    System.arraycopy(part.data, offset, block, 0, remaining);

                    ByteArrayOutputStream payload = new ByteArrayOutputStream(16 + block.length);
                    writeLe32(payload, block.length);
                    writeLe32(payload, sequence);
                    writeLe32(payload, 0);
                    writeLe32(payload, 0);
                    payload.write(block);
                    command(ESP_FLASH_DATA, payload.toByteArray(), checksum(block), 12000);

                    written += remaining;
                    int progressPercent = 5 + (int) Math.min(93, (written * 93) / Math.max(1, total));
                    emit("Flashing", part.name, progressPercent, written, total);
                }
            }

            ByteArrayOutputStream finish = new ByteArrayOutputStream(8);
            writeLe32(finish, 0);
            writeLe32(finish, 0);
            command(ESP_FLASH_END, finish.toByteArray(), 0, 8000);
            emit("Resetting", "Firmware written", 99, total, total);
            resetNormal();
            emit("Flash complete", bundle.chipFamily, 100, total, total);
            return new FlashResult(bundle.chipFamily, bundle.version, bundle.parts.size(), total);
        } finally {
            closeSerial();
        }
    }

    private void openSerial() throws IOException {
        UsbSerialDriver driver = UsbSerialProber.getDefaultProber().probeDevice(device);
        if (driver == null || driver.getPorts().isEmpty()) {
            throw new IOException("No Android serial driver for this USB device");
        }

        connection = usbManager.openDevice(device);
        if (connection == null) {
            throw new IOException("USB permission is missing for this device");
        }

        port = driver.getPorts().get(0);
        port.open(connection);
        port.setParameters(
            DEFAULT_BAUD,
            UsbSerialPort.DATABITS_8,
            UsbSerialPort.STOPBITS_1,
            UsbSerialPort.PARITY_NONE
        );
        purgeBuffers();
    }

    private void syncBootloader() throws Exception {
        byte[] syncPayload = new byte[36];
        syncPayload[0] = 0x07;
        syncPayload[1] = 0x07;
        syncPayload[2] = 0x12;
        syncPayload[3] = 0x20;
        Arrays.fill(syncPayload, 4, syncPayload.length, (byte) 0x55);

        enterBootloader();
        for (int attempt = 1; attempt <= 10; attempt++) {
            purgeBuffers();
            try {
                command(ESP_SYNC, syncPayload, 0, 1000);
                return;
            } catch (IOException ignored) {
                emit("Syncing", "Hold BOOT, tap RESET if this keeps retrying", 2, 0, 1);
                sleep(180);
            }
        }

        enterBootloader();
        for (int attempt = 1; attempt <= 8; attempt++) {
            try {
                command(ESP_SYNC, syncPayload, 0, 1200);
                return;
            } catch (IOException ignored) {
                emit("Syncing", "Still waiting for ESP32 bootloader", 3, 0, 1);
                sleep(220);
            }
        }

        throw new IOException("Could not sync ESP32. Hold BOOT, tap RESET, release BOOT, then Flash again.");
    }

    private void flashBegin(FirmwarePart part) throws IOException {
        int blocks = (part.data.length + BLOCK_SIZE - 1) / BLOCK_SIZE;
        ByteArrayOutputStream payload = new ByteArrayOutputStream(16);
        writeLe32(payload, align4k(part.data.length));
        writeLe32(payload, blocks);
        writeLe32(payload, BLOCK_SIZE);
        writeLe32(payload, part.offset);
        command(ESP_FLASH_BEGIN, payload.toByteArray(), 0, 12000);
    }

    private EspResponse command(int op, byte[] data, int checksum, int timeoutMs) throws IOException {
        ByteArrayOutputStream packet = new ByteArrayOutputStream(8 + data.length);
        packet.write(0x00);
        packet.write(op);
        writeLe16(packet, data.length);
        writeLe32(packet, checksum);
        packet.write(data, 0, data.length);

        port.write(slipEncode(packet.toByteArray()), USB_TIMEOUT_MS);

        long deadline = System.currentTimeMillis() + timeoutMs;
        EspResponse last = null;
        while (System.currentTimeMillis() < deadline) {
            byte[] frame = readSlipFrame(deadline);
            if (frame.length < 8 || (frame[1] & 0xFF) != op) {
                continue;
            }

            EspResponse response = EspResponse.parse(frame);
            last = response;
            if (response.ok()) {
                return response;
            }
        }

        if (last != null) {
            throw new IOException(String.format(Locale.US, "ESP command 0x%02X failed", op));
        }
        throw new IOException(String.format(Locale.US, "ESP command 0x%02X timed out", op));
    }

    private byte[] readSlipFrame(long deadline) throws IOException {
        ByteArrayOutputStream frame = new ByteArrayOutputStream();
        byte[] buffer = new byte[256];
        boolean started = false;
        boolean escaped = false;

        while (System.currentTimeMillis() < deadline) {
            int waitMs = (int) Math.max(1, Math.min(120, deadline - System.currentTimeMillis()));
            int read = port.read(buffer, waitMs);
            if (read <= 0) {
                continue;
            }

            for (int index = 0; index < read; index++) {
                int value = buffer[index] & 0xFF;
                if (value == SLIP_END) {
                    if (started && frame.size() > 0) {
                        return frame.toByteArray();
                    }
                    started = true;
                    escaped = false;
                    frame.reset();
                    continue;
                }

                if (!started) {
                    continue;
                }

                if (escaped) {
                    if (value == SLIP_ESC_END) {
                        frame.write(SLIP_END);
                    } else if (value == SLIP_ESC_ESC) {
                        frame.write(SLIP_ESC);
                    } else {
                        frame.write(value);
                    }
                    escaped = false;
                } else if (value == SLIP_ESC) {
                    escaped = true;
                } else {
                    frame.write(value);
                }
            }
        }

        throw new IOException("Timed out waiting for ESP response");
    }

    private byte[] slipEncode(byte[] payload) {
        ByteArrayOutputStream output = new ByteArrayOutputStream(payload.length + 2);
        output.write(SLIP_END);
        for (byte raw : payload) {
            int value = raw & 0xFF;
            if (value == SLIP_END) {
                output.write(SLIP_ESC);
                output.write(SLIP_ESC_END);
            } else if (value == SLIP_ESC) {
                output.write(SLIP_ESC);
                output.write(SLIP_ESC_ESC);
            } else {
                output.write(value);
            }
        }
        output.write(SLIP_END);
        return output.toByteArray();
    }

    private void enterBootloader() {
        try {
            port.setDTR(false);
            port.setRTS(true);
            sleep(100);
            port.setDTR(true);
            port.setRTS(false);
            sleep(90);
            port.setDTR(false);
            sleep(80);
        } catch (Exception ignored) {
            // Some native USB adapters do not expose modem-control lines.
        }
    }

    private void resetNormal() {
        try {
            port.setDTR(false);
            port.setRTS(true);
            sleep(100);
            port.setRTS(false);
            sleep(120);
        } catch (Exception ignored) {
            // A manual reset after flashing is acceptable.
        }
    }

    private void purgeBuffers() {
        try {
            port.purgeHwBuffers(true, true);
        } catch (Exception ignored) {
            // Not all drivers implement purge; stale bytes are ignored by SLIP framing.
        }
    }

    private void closeSerial() {
        if (port != null) {
            try {
                port.close();
            } catch (Exception ignored) {
                // Close best-effort.
            }
            port = null;
        }
        if (connection != null) {
            connection.close();
            connection = null;
        }
    }

    private void emit(String stage, String detail, int progressPercent, long bytes, long totalBytes) {
        if (progress != null) {
            progress.onProgress(stage, detail, progressPercent, bytes, totalBytes);
        }
    }

    private String deviceLabel() {
        return String.format(Locale.US, "USB %04X:%04X", device.getVendorId(), device.getProductId());
    }

    private static int checksum(byte[] data) {
        int checksum = 0xEF;
        for (byte value : data) {
            checksum ^= value & 0xFF;
        }
        return checksum;
    }

    private static int align4k(int value) {
        return (value + 0xFFF) & ~0xFFF;
    }

    private static void writeLe16(ByteArrayOutputStream output, int value) {
        output.write(value & 0xFF);
        output.write((value >> 8) & 0xFF);
    }

    private static void writeLe32(ByteArrayOutputStream output, int value) {
        output.write(value & 0xFF);
        output.write((value >> 8) & 0xFF);
        output.write((value >> 16) & 0xFF);
        output.write((value >> 24) & 0xFF);
    }

    private static int readLe16(byte[] data, int offset) {
        return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8);
    }

    private static int readLe32(byte[] data, int offset) {
        return (data[offset] & 0xFF) |
            ((data[offset + 1] & 0xFF) << 8) |
            ((data[offset + 2] & 0xFF) << 16) |
            ((data[offset + 3] & 0xFF) << 24);
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    interface InputProvider {
        InputStream open(String path) throws IOException;
    }

    private static class EspResponse {
        final int direction;
        final int op;
        final int size;
        final int value;
        final byte[] data;

        EspResponse(int direction, int op, int size, int value, byte[] data) {
            this.direction = direction;
            this.op = op;
            this.size = size;
            this.value = value;
            this.data = data;
        }

        static EspResponse parse(byte[] frame) {
            int size = readLe16(frame, 2);
            int available = Math.max(0, Math.min(size, frame.length - 8));
            byte[] data = Arrays.copyOfRange(frame, 8, 8 + available);
            return new EspResponse(frame[0] & 0xFF, frame[1] & 0xFF, size, readLe32(frame, 4), data);
        }

        boolean ok() {
            if (direction != 0x01) {
                return false;
            }
            if (data.length < 2) {
                return true;
            }
            int status = data[data.length - 2] & 0xFF;
            int error = data[data.length - 1] & 0xFF;
            return status == 0 && error == 0;
        }
    }

    private static class FirmwareBundle {
        final String chipFamily;
        final String version;
        final List<FirmwarePart> parts;

        FirmwareBundle(String chipFamily, String version, List<FirmwarePart> parts) {
            this.chipFamily = chipFamily;
            this.version = version;
            this.parts = parts;
        }

        static FirmwareBundle load(InputProvider inputProvider, String requestedChipFamily) throws Exception {
            String manifestText = readText(inputProvider.open("public/flasher/manifest.json"));
            JSONObject manifest = new JSONObject(manifestText);
            String version = manifest.optString("version", "unknown");
            JSONArray builds = manifest.getJSONArray("builds");
            JSONObject build = null;
            String wanted = normalizeChipFamily(requestedChipFamily);

            for (int index = 0; index < builds.length(); index++) {
                JSONObject candidate = builds.getJSONObject(index);
                String chipFamily = normalizeChipFamily(candidate.optString("chipFamily", ""));
                if (wanted.isEmpty() || wanted.equals(chipFamily)) {
                    build = candidate;
                    break;
                }
            }
            if (build == null && builds.length() > 0) {
                build = builds.getJSONObject(0);
            }
            if (build == null) {
                throw new IOException("No bundled firmware builds found");
            }

            String chipFamily = build.optString("chipFamily", "ESP32");
            JSONArray partArray = build.getJSONArray("parts");
            List<FirmwarePart> parts = new ArrayList<>();
            for (int index = 0; index < partArray.length(); index++) {
                JSONObject part = partArray.getJSONObject(index);
                String path = part.getString("path");
                int offset = part.getInt("offset");
                byte[] data = readBytes(inputProvider.open("public/flasher/" + path));
                parts.add(new FirmwarePart(fileName(path), offset, data));
            }
            if (parts.isEmpty()) {
                throw new IOException("Selected firmware build has no flash parts");
            }

            return new FirmwareBundle(chipFamily, version, parts);
        }

        long totalBytes() {
            long total = 0;
            for (FirmwarePart part : parts) {
                total += part.data.length;
            }
            return total;
        }

        private static String normalizeChipFamily(String value) {
            return value == null ? "" : value.trim().toUpperCase(Locale.US).replace("_", "-");
        }

        private static String fileName(String path) {
            int index = path.lastIndexOf('/');
            return index >= 0 ? path.substring(index + 1) : path;
        }

        private static String readText(InputStream input) throws IOException {
            return new String(readBytes(input), StandardCharsets.UTF_8);
        }

        private static byte[] readBytes(InputStream input) throws IOException {
            try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = stream.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                }
                return output.toByteArray();
            }
        }
    }

    private static class FirmwarePart {
        final String name;
        final int offset;
        final byte[] data;

        FirmwarePart(String name, int offset, byte[] data) {
            this.name = name;
            this.offset = offset;
            this.data = data;
        }
    }
}

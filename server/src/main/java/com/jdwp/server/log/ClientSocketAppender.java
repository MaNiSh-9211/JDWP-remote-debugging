package com.jdwp.server.log;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.AppenderBase;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Streams log events as newline-delimited JSON to the JDWP debug client's
 * log receiver ({@code com.jdwp.client.service.LogReceiverService}), which
 * expects exactly these fields per line:
 * {@code type, stream, thread, timestamp, message}.
 *
 * Lets the Studio UI show live application logs even when this demo app runs
 * inside a container — where javaagent injection is not possible.
 */
public class ClientSocketAppender extends AppenderBase<ILoggingEvent> {

    private String host = "host.docker.internal";
    private int port = 9999;
    private long reconnectDelayMs = 5000;

    private transient Socket socket;
    private transient BufferedWriter writer;
    private transient long lastConnectAttempt;

    public String getHost() { return host; }
    public void setHost(String host) { this.host = host; }
    public int getPort() { return port; }
    public void setPort(int port) { this.port = port; }
    public long getReconnectDelayMs() { return reconnectDelayMs; }
    public void setReconnectDelayMs(long v) { this.reconnectDelayMs = v; }

    @Override
    protected void append(ILoggingEvent event) {
        ensureConnected();
        if (writer == null) {
            return; // receiver not up yet; drop silently (reconnects lazily)
        }
        try {
            writer.write(toJson(event));
            writer.write('\n');
            writer.flush();
        } catch (IOException e) {
            closeQuietly();
        }
    }

    private void ensureConnected() {
        if (socket != null && socket.isConnected() && !socket.isClosed()) {
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastConnectAttempt < reconnectDelayMs) {
            return;
        }
        lastConnectAttempt = now;
        try {
            socket = new Socket(host, port);
            socket.setTcpNoDelay(true);
            writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            closeQuietly(); // receiver offline — retry after delay
        }
    }

    /** NDJSON matching LogReceiverService's expected schema. */
    private String toJson(ILoggingEvent e) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"type\":\"application\",\"stream\":\"stdout\"");
        sb.append(",\"thread\":\"").append(escape(e.getThreadName())).append('"');
        sb.append(",\"timestamp\":").append(e.getTimeStamp());
        sb.append(",\"message\":\"").append(escape(formatMessage(e))).append("\"}");
        return sb.toString();
    }

    private String formatMessage(ILoggingEvent e) {
        String level = e.getLevel() == null ? "INFO" : e.getLevel().toString();
        String logger = e.getLoggerName() == null ? "?" : e.getLoggerName();
        String msg = e.getFormattedMessage() == null ? "" : e.getFormattedMessage();
        return "[" + level + "] " + logger + " - " + msg;
    }

    private static String escape(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }

    private void closeQuietly() {
        try { if (writer != null) writer.close(); } catch (IOException ignore) { }
        try { if (socket != null && !socket.isClosed()) socket.close(); } catch (IOException ignore) { }
        writer = null;
        socket = null;
    }

    @Override
    public void stop() {
        closeQuietly();
        super.stop();
    }
}

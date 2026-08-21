package com.jdwp.client.agent;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.AppenderBase;

/**
 * Custom Logback Appender that forwards logs to the agent's log receiver
 */
public class LogbackAppenderInterceptor extends AppenderBase<ILoggingEvent> {
    
    @Override
    protected void append(ILoggingEvent event) {
        try {
            String level = event.getLevel().toString();
            String loggerName = event.getLoggerName();
            String message = event.getFormattedMessage();
            // Note: IThrowableProxy doesn't expose getThrowable() directly
            // We'll extract it via reflection in ConsoleLogAgent if needed
            Throwable throwable = null;
            
            // Forward to agent's log sender
            ConsoleLogAgent.sendFrameworkLog(level, loggerName, message, throwable);
        } catch (Throwable t) {
            // Never crash - silently drop
        }
    }
}

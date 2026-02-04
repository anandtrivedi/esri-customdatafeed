/**
 * auditLog.js
 * Audit logging module for tracking ArcGIS user queries
 *
 * Logs important security events:
 * - User authentication attempts
 * - Data access requests
 * - Failed authorization attempts
 */

const fs = require('fs');
const path = require('path');

class AuditLogger {
  constructor(logFilePath) {
    this.enabled = process.env.ENABLE_AUDIT_LOG === 'true';
    this.logFilePath = logFilePath || process.env.AUDIT_LOG_FILE || './logs/audit.log';

    if (this.enabled) {
      // Ensure log directory exists
      const logDir = path.dirname(this.logFilePath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      console.log(`✅ Audit logging enabled: ${this.logFilePath}`);
    } else {
      console.log('ℹ️  Audit logging disabled (set ENABLE_AUDIT_LOG=true to enable)');
    }
  }

  /**
   * Write audit log entry
   * @param {string} event - Event type (e.g., 'AUTH_SUCCESS', 'QUERY', 'AUTH_FAILURE')
   * @param {object} details - Event details
   */
  log(event, details) {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      event,
      ...details
    };

    const logLine = JSON.stringify(logEntry) + '\n';

    try {
      fs.appendFileSync(this.logFilePath, logLine, 'utf8');
    } catch (error) {
      console.error('Failed to write audit log:', error.message);
    }
  }

  /**
   * Log successful authentication
   */
  logAuthSuccess(username, method, ipAddress) {
    this.log('AUTH_SUCCESS', {
      username,
      method,
      ipAddress,
      success: true
    });
  }

  /**
   * Log failed authentication
   */
  logAuthFailure(username, method, ipAddress, reason) {
    this.log('AUTH_FAILURE', {
      username,
      method,
      ipAddress,
      success: false,
      reason
    });
  }

  /**
   * Log data query request
   */
  logQuery(username, tableName, queryParams, recordCount, ipAddress) {
    this.log('QUERY', {
      username,
      tableName,
      queryParams: {
        where: queryParams.where || 'none',
        returnCountOnly: queryParams.returnCountOnly || false,
        resultRecordCount: queryParams.resultRecordCount,
        outFields: queryParams.outFields || '*'
      },
      recordCount,
      ipAddress
    });
  }

  /**
   * Log authorization failure
   */
  logAuthorizationFailure(username, tableName, ipAddress, reason) {
    this.log('AUTHORIZATION_FAILURE', {
      username,
      tableName,
      ipAddress,
      reason
    });
  }
}

// Singleton instance
let auditLoggerInstance = null;

/**
 * Get audit logger instance
 */
function getAuditLogger() {
  if (!auditLoggerInstance) {
    auditLoggerInstance = new AuditLogger();
  }
  return auditLoggerInstance;
}

module.exports = { getAuditLogger, AuditLogger };

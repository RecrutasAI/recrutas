import { db } from "./db";
import {
  notifications,
  notificationPreferences,
  connectionStatus,
  users,
  jobPostings,
  jobApplications,
  jobMatches,
  type InsertNotification,
  type NotificationPreferences,
  type User
} from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { gt } from "drizzle-orm/sql/expressions";
import { WebSocket } from "ws";
import { sendApplicationStatusEmail, sendInterviewScheduledEmail, sendNewMatchEmail } from "./email-service";
import { sendEmail as sendTransactionalEmail, candidateExamPassEmail, candidateExamFailEmail } from "./lib/email";
import { track as trackAnalytics } from "./lib/analytics";
import { captureException } from "./error-monitoring";
import jwt from 'jsonwebtoken';
import type { IncomingMessage } from 'http';

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

interface NotificationData {
  userId: string;
  type: InsertNotification['type'];
  title: string;
  message: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  data?: any;
  relatedJobId?: number;
  relatedApplicationId?: number;
  relatedMatchId?: number;
}

// Polling state for Vercel serverless compatibility
interface PollingState {
  lastPollTime: Date;
  pendingNotifications: any[];
}

interface WebSocketClient extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

class NotificationService {
  private connectedClients: Map<string, WebSocketClient[]> = new Map();
  private pollingClients: Map<string, PollingState> = new Map();
  private readonly POLLING_TIMEOUT = 30000; // 30 seconds for long-polling
  private readonly STALE_CONNECTION_TIMEOUT = 60000; // 1 minute
  private readonly MAX_CONNECTIONS_PER_USER = 5; // Limit connections per user
  private heartbeatIntervals: NodeJS.Timeout[] = [];

  // Verify JWT token from WebSocket upgrade request
  verifyWebSocketToken(request: IncomingMessage): string | null {
    try {
      if (!JWT_SECRET) return null;
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      const token = url.searchParams.get('token');
      if (!token) return null;
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as any;
      const userId = payload.sub || payload.user_id;
      return typeof userId === 'string' ? userId : null;
    } catch {
      return null;
    }
  }

  // Safe send that catches errors instead of crashing
  private safeSend(ws: WebSocketClient, message: string) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    } catch (error) {
      console.error('[NotificationService] ws.send failed:', error);
      if (ws.userId) this.removeConnection(ws.userId, ws);
    }
  }

  // WebSocket connection management
  addConnection(userId: string, ws: WebSocketClient) {
    ws.userId = userId;
    ws.isAlive = true;
    
    const userConnections = this.connectedClients.get(userId) || [];
    
    // Enforce max connections per user - remove oldest if limit reached
    if (userConnections.length >= this.MAX_CONNECTIONS_PER_USER) {
      const oldestConnection = userConnections.shift();
      if (oldestConnection) {
        oldestConnection.close(1000, 'Max connections exceeded');
      }
    }
    
    userConnections.push(ws);
    this.connectedClients.set(userId, userConnections);

    // Update connection status in database
    this.updateConnectionStatus(userId, true);

    // Set up heartbeat
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('close', () => {
      this.removeConnection(userId, ws);
    });

    ws.on('error', () => {
      this.removeConnection(userId, ws);
    });
  }

  removeConnection(userId: string, ws: WebSocketClient) {
    const userConnections = this.connectedClients.get(userId) || [];
    const filteredConnections = userConnections.filter(client => client !== ws);
    
    if (filteredConnections.length === 0) {
      this.connectedClients.delete(userId);
      this.updateConnectionStatus(userId, false);
    } else {
      this.connectedClients.set(userId, filteredConnections);
    }
  }

  private async updateConnectionStatus(userId: string, isOnline: boolean) {
    try {
      await db.insert(connectionStatus).values({
        userId,
        isOnline,
        lastSeen: new Date(),
      }).onConflictDoUpdate({
        target: connectionStatus.userId,
        set: {
          isOnline,
          lastSeen: new Date(),
          updatedAt: new Date(),
        }
      });
    } catch (error) {
      console.error('Error updating connection status:', error);
    }
  }

  // Core notification creation
  async createNotification(data: NotificationData): Promise<void> {
    try {
      // Check user notification preferences
      const preferences = await this.getUserPreferences(data.userId);
      if (!this.shouldSendNotification(data, preferences)) {
        return;
      }

      // Store notification in database
      const [notification] = await db.insert(notifications).values({
        userId: data.userId,
        type: data.type,
        title: data.title,
        message: data.message,
        priority: data.priority || 'medium',
        data: data.data,
        relatedJobId: data.relatedJobId,
        relatedApplicationId: data.relatedApplicationId,
        relatedMatchId: data.relatedMatchId,
      }).returning();

      // Send real-time notification if user is connected
      await this.sendRealTimeNotification(data.userId, {
        id: notification.id,
        ...data,
        createdAt: notification.createdAt,
      });

      // Send email notification if enabled
      if (preferences?.emailNotifications && this.isPriorityEmailWorthy(data.priority)) {
        await this.sendEmailNotification(data.userId, data);
      }

    } catch (error) {
      console.error('Error creating notification:', error);
    }
  }

  private async getUserPreferences(userId: string): Promise<NotificationPreferences | null> {
    try {
      const [preferences] = await db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId));
      
      return preferences || null;
    } catch (error) {
      console.error('Error getting user preferences:', error);
      return null;
    }
  }

  private shouldSendNotification(data: NotificationData, preferences: NotificationPreferences | null): boolean {
    if (!preferences) {return true;} // Default to sending if no preferences set

    // Check if in quiet hours
    if (this.isInQuietHours(preferences)) {
      return data.priority === 'urgent';
    }

    // Check specific notification type preferences
    switch (data.type) {
      case 'application_viewed':
      case 'application_ranked':
      case 'application_accepted':
      case 'application_rejected':
      case 'status_update':
        return preferences.applicationUpdates;
      case 'exam_completed':
      case 'exam_passed':
      case 'exam_failed':
      case 'high_score_alert':
        return preferences.examAlerts;
      case 'application_submitted':
        return preferences.applicationUpdates;
      case 'candidate_message':
      case 'direct_connection':
        return preferences.messageNotifications;
      default:
        return preferences.inAppNotifications;
    }
  }

  private isInQuietHours(preferences: NotificationPreferences): boolean {
    if (!preferences.quietHours) {return false;}

    const now = new Date();
    const currentHour = now.getHours();
    const quietHours = preferences.quietHours as { start: string; end: string };
    
    const startHour = parseInt(quietHours.start.split(':')[0]);
    const endHour = parseInt(quietHours.end.split(':')[0]);

    if (startHour <= endHour) {
      return currentHour >= startHour && currentHour < endHour;
    } else {
      return currentHour >= startHour || currentHour < endHour;
    }
  }

  private isPriorityEmailWorthy(priority?: string): boolean {
    return priority === 'high' || priority === 'urgent';
  }

  private async sendRealTimeNotification(userId: string, notification: any) {
    const userConnections = this.connectedClients.get(userId) || [];
    
    const message = JSON.stringify({
      type: 'notification',
      data: notification,
    });

    userConnections.forEach(ws => {
      this.safeSend(ws, message);
    });
  }

  private async sendEmailNotification(userId: string, data: NotificationData) {
    try {
      // Get user email
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));

      if (!user?.email) {
        console.warn(`Cannot send email notification: No email for user ${userId}`);
        return;
      }

      const userName = user.firstName || 'User';

      // Send appropriate email based on notification type
      switch (data.type) {
        case 'application_viewed':
        case 'application_ranked':
        case 'application_accepted':
        case 'application_rejected':
          await sendApplicationStatusEmail(
            user.email,
            userName,
            data.data?.jobTitle || 'Unknown Position',
            data.data?.companyName || 'Unknown Company',
            data.type === 'application_viewed' ? 'viewed' :
            data.type === 'application_ranked' ? 'shortlisted' :
            data.type === 'application_accepted' ? 'accepted' : 'rejected',
            { feedback: data.data?.feedback }
          );
          break;

        case 'interview_scheduled':
          await sendApplicationStatusEmail(
            user.email,
            userName,
            data.data?.jobTitle || 'Unknown Position',
            data.data?.companyName || 'Unknown Company',
            'interview_scheduled',
            { interviewDate: data.data?.interviewDate }
          );
          break;

        case 'new_match':
          await sendNewMatchEmail(
            user.email,
            userName,
            data.data?.jobTitle || 'Unknown Position',
            data.data?.companyName || 'Unknown Company',
            parseInt(data.data?.matchScore || '0'),
            data.data?.skills || [],
            data.relatedJobId || 0
          );
          break;

        default:
          console.log(`Email notification sent to ${user.email}: ${data.title}`);
      }
    } catch (error) {
      await captureException(error as Error, {
        userId,
        action: 'sendEmailNotification',
        component: 'notification-service',
        metadata: { notificationType: data.type }
      });
    }
  }

  // Specific notification creators
  async notifyApplicationViewed(candidateId: string, jobTitle: string, companyName: string, applicationId: number) {
    await this.createNotification({
      userId: candidateId,
      type: 'application_viewed',
      title: 'Application Viewed',
      message: `${companyName} has viewed your application for ${jobTitle}`,
      priority: 'medium',
      relatedApplicationId: applicationId,
      data: { jobTitle, companyName }
    });
  }

  async notifyApplicationRanked(candidateId: string, jobTitle: string, ranking: number, totalCandidates: number, applicationId: number) {
    const priority = ranking <= 3 ? 'high' : 'medium';
    const message = ranking <= 3 
      ? `You're ranked #${ranking} out of ${totalCandidates} candidates for ${jobTitle}!`
      : `You're ranked #${ranking} out of ${totalCandidates} candidates for ${jobTitle}`;

    await this.createNotification({
      userId: candidateId,
      type: 'application_ranked',
      title: 'Application Ranked',
      message,
      priority,
      relatedApplicationId: applicationId,
      data: { jobTitle, ranking, totalCandidates }
    });
  }

  async notifyApplicationAccepted(candidateId: string, jobTitle: string, companyName: string, applicationId: number) {
    await this.createNotification({
      userId: candidateId,
      type: 'application_accepted',
      title: 'Application Accepted!',
      message: `Congratulations! ${companyName} has accepted your application for ${jobTitle}`,
      priority: 'high',
      relatedApplicationId: applicationId,
      data: { jobTitle, companyName }
    });
  }

  async notifyApplicationRejected(candidateId: string, jobTitle: string, companyName: string, applicationId: number) {
    await this.createNotification({
      userId: candidateId,
      type: 'application_rejected',
      title: 'Application Update',
      message: `${companyName} has made a decision on your ${jobTitle} application`,
      priority: 'medium',
      relatedApplicationId: applicationId,
      data: { jobTitle, companyName }
    });
  }

  async notifyExamCompleted(talentOwnerId: string, candidateName: string, jobTitle: string, score: number, applicationId: number, passed = false) {
    const priority = passed ? 'urgent' : score >= 80 ? 'high' : 'medium';
    const title = passed ? '⏰ Candidate Passed: Respond Within 24h' : 'Screening Exam Completed';
    const message = passed
      ? `${candidateName} passed the ${jobTitle} exam with ${score}%. You have 24 hours to respond.`
      : `${candidateName} completed the ${jobTitle} screening exam with ${score}% score`;

    await this.createNotification({
      userId: talentOwnerId,
      type: 'exam_completed',
      title,
      message,
      priority,
      relatedApplicationId: applicationId,
      data: { candidateName, jobTitle, score, passed }
    });
  }

  async notifyCandidateExamResult(candidateId: string, jobTitle: string, score: number, passed: boolean, passingScore: number, applicationId: number, examFeedback?: string, company?: string, ranking?: number, totalCandidates?: number) {
    const priority = passed ? 'high' : 'medium';
    const title = passed ? 'Exam Passed: Chat Unlocked!' : 'Exam Result';
    const message = passed
      ? `You scored ${score}% on the ${jobTitle} screening (threshold: ${passingScore}%). You've unlocked chat with the hiring team!`
      : `You scored ${score}% on the ${jobTitle} screening (threshold: ${passingScore}%). Unfortunately you didn't meet the threshold this time.`;

    await this.createNotification({
      userId: candidateId,
      type: passed ? 'exam_passed' : 'exam_failed',
      title,
      message,
      priority,
      relatedApplicationId: applicationId,
      data: { jobTitle, score, passingScore, passed }
    });

    // Send email
    try {
      const [user] = await db.select().from(users).where(eq(users.id, candidateId));
      if (user?.email) {
        const candidateName = user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : undefined;
        const html = passed
          ? candidateExamPassEmail(candidateName, jobTitle, company || '', score, ranking || 1, totalCandidates || 1)
          : candidateExamFailEmail(candidateName, jobTitle, company || '', score, passingScore, examFeedback);
        await sendTransactionalEmail({
          to: user.email,
          subject: passed ? `You passed the ${jobTitle} exam. Chat unlocked!` : `Your ${jobTitle} exam result`,
          html,
        });

        trackAnalytics(candidateId, 'sla_response_sent', {
          job_title: jobTitle,
          company,
          score,
          passing_score: passingScore,
          passed,
          has_feedback: !!examFeedback,
          ranking,
          total_candidates: totalCandidates,
          application_id: applicationId,
        });
      }
    } catch (err) {
      console.error('[Email] exam result email failed:', err);
    }
  }

  async notifyHighScoreAlert(talentOwnerId: string, candidateName: string, jobTitle: string, score: number, applicationId: number) {
    await this.createNotification({
      userId: talentOwnerId,
      type: 'high_score_alert',
      title: 'High-Scoring Candidate!',
      message: `${candidateName} achieved ${score}% on ${jobTitle} screening - Top performer!`,
      priority: 'high',
      relatedApplicationId: applicationId,
      data: { candidateName, jobTitle, score }
    });
  }

  async notifyDirectConnection(recipientId: string, senderName: string, jobTitle: string, matchId: number) {
    await this.createNotification({
      userId: recipientId,
      type: 'direct_connection',
      title: 'Direct Connection Request',
      message: `${senderName} wants to connect about the ${jobTitle} position`,
      priority: 'high',
      relatedMatchId: matchId,
      data: { senderName, jobTitle }
    });
  }

  async notifyCandidateMessage(recipientId: string, senderName: string, jobTitle: string, messagePreview: string, matchId: number) {
    await this.createNotification({
      userId: recipientId,
      type: 'candidate_message',
      title: 'New Message',
      message: `${senderName}: ${messagePreview.substring(0, 50)}${messagePreview.length > 50 ? '...' : ''}`,
      priority: 'medium',
      relatedMatchId: matchId,
      data: { senderName, jobTitle, messagePreview }
    });
  }

  async notifyJobExpired(candidateId: string, jobTitle: string, companyName: string, applicationId: number, ranking?: number, totalCandidates?: number, passedExam?: boolean) {
    let title = `Job Closed: ${jobTitle}`;
    let message: string;
    let priority: 'high' | 'medium' | 'low' = 'medium';

    if (ranking && totalCandidates) {
      if (passedExam) {
        title = `Hiring Complete: ${jobTitle}`;
        message = `The hiring process for ${jobTitle} at ${companyName} has concluded. You were ranked #${ranking} out of ${totalCandidates} candidates and passed the exam. The hiring team will be in touch with final decisions.`;
        priority = 'high';
      } else {
        message = `The hiring process for ${jobTitle} at ${companyName} has concluded. You were ranked #${ranking} out of ${totalCandidates} candidates. Thank you for your interest!`;
      }
    } else {
      message = `The job posting for ${jobTitle} at ${companyName} has expired and is no longer accepting applications.`;
    }

    await this.createNotification({
      userId: candidateId,
      type: 'job_expired',
      title,
      message,
      priority,
      relatedApplicationId: applicationId,
      data: { jobTitle, companyName, ranking, totalCandidates, passedExam }
    });
  }

  async notifyJobExpiredToTalentOwner(talentOwnerId: string, jobTitle: string, totalCandidates: number) {
    await this.createNotification({
      userId: talentOwnerId,
      type: 'job_expired',
      title: `Job Closed: ${jobTitle}`,
      message: `The job posting "${jobTitle}" has been closed. ${totalCandidates} candidate${totalCandidates !== 1 ? 's' : ''} applied.`,
      priority: 'medium',
      data: { jobTitle, totalCandidates }
    });
  }

  async notifyInterviewScheduled(candidateId: string, companyName: string, jobTitle: string, interviewDate: string, applicationId: number) {
    await this.createNotification({
      userId: candidateId,
      type: 'interview_scheduled',
      title: 'Interview Scheduled',
      message: `${companyName} has scheduled an interview for ${jobTitle} on ${interviewDate}`,
      priority: 'high',
      relatedApplicationId: applicationId,
      data: { companyName, jobTitle, interviewDate }
    });
  }

  async notifyNewMatch(candidateId: string, jobTitle: string, companyName: string, matchScore: string, jobId: number, matchId: number) {
    const priority = parseInt(matchScore) >= 85 ? 'high' : 'medium';
    
    await this.createNotification({
      userId: candidateId,
      type: 'new_match',
      title: 'New Job Match!',
      message: `${matchScore}% match found: ${jobTitle} at ${companyName}`,
      priority,
      relatedJobId: jobId,
      relatedMatchId: matchId,
      data: { jobTitle, companyName, matchScore }
    });
  }

  /**
   * Broadcast a chat message event to both participants in a room.
   * Sends a lightweight { type: 'new_message', data: { roomId } } frame
   * so the client can invalidate its chat queries instantly.
   */
  broadcastChatMessage(roomId: number, senderUserId: string, recipientUserIds: string[]) {
    const payload = JSON.stringify({ type: 'new_message', data: { roomId } });
    for (const uid of recipientUserIds) {
      if (uid === senderUserId) continue; // don't echo back to sender
      const connections = this.connectedClients.get(uid) || [];
      connections.forEach(ws => this.safeSend(ws, payload));
    }
  }

  // Utility methods
  async getUnreadNotifications(userId: string, limit: number = 20) {
    try {
      return await db
        .select()
        .from(notifications)
        .where(and(
          eq(notifications.userId, userId),
          eq(notifications.read, false)
        ))
        .orderBy(desc(notifications.createdAt))
        .limit(limit);
    } catch (error) {
      console.error('Error getting unread notifications:', error);
      return [];
    }
  }

  async getAllNotifications(userId: string, limit: number = 50) {
    try {
      return await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt))
        .limit(limit);
    } catch (error) {
      console.error('Error getting all notifications:', error);
      return [];
    }
  }

  async markAsRead(notificationId: number, userId: string) {
    try {
      await db
        .update(notifications)
        .set({ 
          read: true, 
          readAt: new Date() 
        })
        .where(and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId)
        ));
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  }

  async markAllAsRead(userId: string) {
    try {
      await db
        .update(notifications)
        .set({ 
          read: true, 
          readAt: new Date() 
        })
        .where(eq(notifications.userId, userId));
    } catch (error) {
      console.error('Error marking all notifications as read:', error);
    }
  }

  async getUnreadCount(userId: string): Promise<number> {
    try {
      const result = await db
        .select()
        .from(notifications)
        .where(and(
          eq(notifications.userId, userId),
          eq(notifications.read, false)
        ));
      
      return result.length;
    } catch (error) {
      console.error('Error getting unread count:', error);
      return 0;
    }
  }

  // Heartbeat for WebSocket connections
  startHeartbeat() {
    if (this.heartbeatIntervals.length > 0) return; // Guard against double-init

    this.heartbeatIntervals.push(
      setInterval(() => {
        this.connectedClients.forEach((connections, userId) => {
          connections.forEach((ws) => {
            try {
              if (!ws.isAlive) {
                ws.terminate();
                this.removeConnection(userId, ws);
                return;
              }
              ws.isAlive = false;
              ws.ping();
            } catch (error) {
              console.error('[NotificationService] Heartbeat error:', error);
              this.removeConnection(userId, ws);
            }
          });
        });
      }, 30000), // 30 seconds

      // Cleanup stale polling clients
      setInterval(() => {
        const now = Date.now();
        this.pollingClients.forEach((state, userId) => {
          if (now - state.lastPollTime.getTime() > this.STALE_CONNECTION_TIMEOUT) {
            this.pollingClients.delete(userId);
          }
        });
      }, 60000), // Every minute
    );
  }

  stopHeartbeat() {
    this.heartbeatIntervals.forEach(clearInterval);
    this.heartbeatIntervals = [];
  }

  // ============================================
  // POLLING-BASED NOTIFICATIONS (Vercel Compatible)
  // ============================================

  /**
   * Get notifications for polling clients (Vercel serverless compatible)
   * Supports both long-polling and regular polling
   */
  async pollNotifications(userId: string, options: {
    lastNotificationId?: number;
    longPoll?: boolean;
    timeout?: number;
  } = {}): Promise<{
    notifications: any[];
    unreadCount: number;
    hasMore: boolean;
  }> {
    const { lastNotificationId, longPoll = false, timeout = this.POLLING_TIMEOUT } = options;

    // Update polling state
    this.pollingClients.set(userId, {
      lastPollTime: new Date(),
      pendingNotifications: []
    });

    try {
      // Get new notifications since last poll
      const query = db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt))
        .limit(50);

      if (lastNotificationId) {
        const results = await db
          .select()
          .from(notifications)
          .where(and(
            eq(notifications.userId, userId),
            gt(notifications.id, lastNotificationId)
          ))
          .orderBy(desc(notifications.createdAt))
          .limit(50);

        // If long-polling and no new notifications, wait briefly then return
        if (longPoll && results.length === 0) {
          // Short wait to avoid tight polling loops
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Check again
          const retryResults = await db
            .select()
            .from(notifications)
            .where(and(
              eq(notifications.userId, userId),
              gt(notifications.id, lastNotificationId)
            ))
            .orderBy(desc(notifications.createdAt))
            .limit(50);

          const unreadCount = await this.getUnreadCount(userId);
          return {
            notifications: retryResults,
            unreadCount,
            hasMore: retryResults.length >= 50
          };
        }

        const unreadCount = await this.getUnreadCount(userId);
        return {
          notifications: results,
          unreadCount,
          hasMore: results.length >= 50
        };
      }

      // Initial poll - get recent notifications
      const results = await query;
      const unreadCount = await this.getUnreadCount(userId);

      return {
        notifications: results,
        unreadCount,
        hasMore: results.length >= 50
      };
    } catch (error) {
      await captureException(error as Error, {
        userId,
        action: 'pollNotifications',
        component: 'notification-service'
      });
      return {
        notifications: [],
        unreadCount: 0,
        hasMore: false
      };
    }
  }

  /**
   * Get real-time status (for polling clients to check connection status)
   */
  async getConnectionStatus(userId: string): Promise<{
    isOnline: boolean;
    lastSeen: Date | null;
    connectionType: 'websocket' | 'polling' | 'disconnected';
  }> {
    const hasWebSocket = this.connectedClients.has(userId);
    const hasPolling = this.pollingClients.has(userId);

    let lastSeen: Date | null = null;

    try {
      const [status] = await db
        .select()
        .from(connectionStatus)
        .where(eq(connectionStatus.userId, userId));

      if (status) {
        lastSeen = status.lastSeen;
      }
    } catch (error) {
      console.error('Error getting connection status:', error);
    }

    return {
      isOnline: hasWebSocket || hasPolling,
      lastSeen,
      connectionType: hasWebSocket ? 'websocket' : (hasPolling ? 'polling' : 'disconnected')
    };
  }

  /**
   * Subscribe to notifications via polling (register polling client)
   */
  async subscribePolling(userId: string): Promise<{ success: boolean; pollingInterval: number }> {
    this.pollingClients.set(userId, {
      lastPollTime: new Date(),
      pendingNotifications: []
    });

    await this.updateConnectionStatus(userId, true);

    return {
      success: true,
      pollingInterval: 5000 // Recommend 5 second polling interval
    };
  }

  /**
   * Unsubscribe from polling
   */
  async unsubscribePolling(userId: string): Promise<void> {
    this.pollingClients.delete(userId);

    // Only mark offline if no WebSocket connection exists
    if (!this.connectedClients.has(userId)) {
      await this.updateConnectionStatus(userId, false);
    }
  }

  /**
   * Check if user has any active connection (WebSocket or polling)
   */
  isUserConnected(userId: string): boolean {
    const hasWebSocket = this.connectedClients.has(userId) &&
      (this.connectedClients.get(userId)?.length ?? 0) > 0;
    const hasPolling = this.pollingClients.has(userId);

    return hasWebSocket || hasPolling;
  }

  /**
   * Clean up stale WebSocket connections
   */
  cleanupStaleConnections(): void {
    const now = Date.now();
    
    for (const [userId, connections] of this.connectedClients.entries()) {
      const activeConnections = connections.filter(ws => {
        // Check if connection is still alive
        if (!ws.isAlive) {
          ws.terminate();
          return false;
        }
        return true;
      });
      
      if (activeConnections.length === 0) {
        this.connectedClients.delete(userId);
        this.updateConnectionStatus(userId, false);
      } else {
        this.connectedClients.set(userId, activeConnections);
      }
    }
  }

  /**
   * Start periodic cleanup of stale connections
   */
  startConnectionCleanup(): void {
    // Run cleanup every 30 seconds
    setInterval(() => {
      this.cleanupStaleConnections();
    }, 30000);
  }
}

export const notificationService = new NotificationService();

// Start connection cleanup
notificationService.startConnectionCleanup();
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoleBasedAuth } from "@/hooks/useRoleBasedAuth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Bell,
  BriefcaseIcon,
  Trophy,
  XCircle,
  Eye,
  MessageSquare,
  Calendar,
  Sparkles,
  CheckCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

// Vercel serves the app without a WebSocket server: /ws answers with the SPA's
// index.html, so every dashboard load logged a failed handshake. The socket
// only exists on the Express dev server, or wherever VITE_REALTIME_WS=true.
const REALTIME_SOCKET = import.meta.env.DEV || import.meta.env.VITE_REALTIME_WS === 'true';

interface ServerNotification {
  id: number;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

interface RealTimeNotificationsProps {
  onNavigate?: (tab?: string, path?: string) => void;
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  exam_passed: <Trophy className="h-4 w-4 text-green-500" />,
  exam_failed: <XCircle className="h-4 w-4 text-red-500" />,
  exam_completed: <Trophy className="h-4 w-4 text-yellow-500" />,
  application_viewed: <Eye className="h-4 w-4 text-blue-500" />,
  application_submitted: <CheckCircle className="h-4 w-4 text-blue-500" />,
  application_ranked: <CheckCircle className="h-4 w-4 text-green-500" />,
  application_accepted: <CheckCircle className="h-4 w-4 text-green-600" />,
  application_rejected: <XCircle className="h-4 w-4 text-red-500" />,
  status_update: <CheckCircle className="h-4 w-4 text-blue-500" />,
  interview_scheduled: <Calendar className="h-4 w-4 text-purple-500" />,
  candidate_message: <MessageSquare className="h-4 w-4 text-indigo-500" />,
  direct_connection: <MessageSquare className="h-4 w-4 text-indigo-500" />,
  new_match: <BriefcaseIcon className="h-4 w-4 text-blue-500" />,
  new_application: <BriefcaseIcon className="h-4 w-4 text-blue-500" />,
  high_score_alert: <Sparkles className="h-4 w-4 text-yellow-500" />,
};

function getIcon(type: string): React.ReactNode {
  return TYPE_ICON[type] ?? <Bell className="h-4 w-4 text-gray-500" />;
}

function getNavigation(type: string): { tab?: string; path?: string } {
  switch (type) {
    case 'exam_passed':
    case 'exam_failed':
    case 'exam_completed':
    case 'application_submitted':
    case 'application_viewed':
    case 'application_ranked':
    case 'application_accepted':
    case 'application_rejected':
    case 'status_update':
    case 'interview_scheduled':
      return { tab: 'applications' };
    case 'candidate_message':
    case 'direct_connection':
      return { path: '/chat' };
    case 'new_match':
      return { tab: 'jobs' };
    default:
      return {};
  }
}

export default function RealTimeNotifications({ onNavigate }: RealTimeNotificationsProps) {
  const { user } = useRoleBasedAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [wsNotifications, setWsNotifications] = useState<ServerNotification[]>([]);

  // Fetch persisted notifications from server
  const { data: serverNotifications = [] } = useQuery<ServerNotification[]>({
    queryKey: ['/api/notifications'],
    enabled: !!user,
    refetchOnWindowFocus: true,
    // The push socket below doesn't exist on Vercel, so poll there.
    refetchInterval: REALTIME_SOCKET ? false : 60_000,
  });

  const markAsReadMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest('POST', `/api/notifications/${id}/read`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/notifications'] });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: async () => {
      await apiRequest('POST', '/api/notifications/mark-all-read');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/notifications'] });
      setWsNotifications([]);
    },
  });

  // WebSocket for real-time pushes
  useEffect(() => {
    if (!user || !REALTIME_SOCKET) {return;}

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'join', userId: user.id }));
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!data.type || data.type === 'connected') {return;}

        // Refresh server notifications so DB-persisted ones appear
        queryClient.invalidateQueries({ queryKey: ['/api/notifications'] });

        const title = data.title || data.type.replace(/_/g, ' ');
        const message = data.message || data.match?.job?.title || '';

        toast({ title, description: message });
      } catch { /* intentional */ }
    };

    return () => socket.close();
  }, [user?.id]);

  // Merge: server notifications are canonical; ws extras are deduped
  const safeServerNotifications = Array.isArray(serverNotifications) ? serverNotifications : [];
  const serverIds = new Set(safeServerNotifications.map(n => n.id));
  const allNotifications: ServerNotification[] = [
    ...safeServerNotifications,
    ...wsNotifications.filter(n => !serverIds.has(n.id)),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const unreadCount = allNotifications.filter(n => !n.read).length;

  const handleClick = (notification: ServerNotification) => {
    if (!notification.read) {
      markAsReadMutation.mutate(notification.id);
    }
    const nav = getNavigation(notification.type);
    if (onNavigate && (nav.tab || nav.path)) {
      onNavigate(nav.tab, nav.path);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="relative">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0 text-xs"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="p-2">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold">Notifications</h3>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => markAllReadMutation.mutate()}
                disabled={markAllReadMutation.isPending}
              >
                Mark all read
              </Button>
            )}
          </div>

          {allNotifications.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No notifications yet
            </p>
          ) : (
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {allNotifications.slice(0, 20).map((notification) => (
                <DropdownMenuItem
                  key={notification.id}
                  className={`flex items-start gap-2 p-2 cursor-pointer rounded ${
                    !notification.read ? 'bg-blue-50 dark:bg-blue-950/30' : ''
                  }`}
                  onClick={() => handleClick(notification)}
                >
                  <div className="mt-0.5 shrink-0">{getIcon(notification.type)}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-tight">{notification.title}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">{notification.message}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(notification.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  {!notification.read && (
                    <div className="w-2 h-2 bg-blue-500 rounded-full mt-1 shrink-0" />
                  )}
                </DropdownMenuItem>
              ))}
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

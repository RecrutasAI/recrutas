import { useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useSessionContext } from "@supabase/auth-helpers-react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { ArrowLeft, User } from "lucide-react";
import ChatInterface from "@/components/chat-interface";

export default function Chat() {
  const params = useParams<{ id?: string }>();
  const roomId = params.id;
  const [, setLocation] = useLocation();
  const { session, isLoading: isSessionLoading } = useSessionContext();
  const { toast } = useToast();

  // Redirect to login only after session has fully resolved (not during loading)
  useEffect(() => {
    if (!isSessionLoading && !session) {
      toast({
        title: "Unauthorized",
        description: "You are logged out. Logging in again...",
        variant: "destructive",
      });
      setTimeout(() => {
        setLocation("/auth");
      }, 500);
    }
  }, [session, isSessionLoading, toast]);

  const { data: chatRooms = [], isLoading: roomsLoading } = useQuery({
    queryKey: ["/api/chat/rooms"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/chat/rooms");
      if (!response.ok) throw new Error(`Failed to load chat rooms: ${response.status}`);
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    },
    enabled: !!session?.user,
    retry: false,
  });

  if (isSessionLoading || !session?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!roomId) {
    // Show chat rooms list
    return (
      <div className="min-h-screen bg-background">
        {/* Navigation */}
        <nav className="bg-card border-b border-border">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between h-14 sm:h-16">
              <div className="flex items-center space-x-2 sm:space-x-4">
                <Button variant="ghost" size="sm" onClick={() => window.history.back()}>
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <h1 className="text-lg sm:text-xl font-semibold">Messages</h1>
              </div>
            </div>
          </div>
        </nav>

        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <Card>
            <CardHeader className="p-4 sm:p-6">
              <h2 className="text-base sm:text-lg font-semibold">Your Conversations</h2>
            </CardHeader>
            <CardContent>
              {roomsLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="animate-pulse flex items-center space-x-3 p-4">
                      <div className="w-10 h-10 bg-muted rounded-full"></div>
                      <div className="flex-1">
                        <div className="h-4 bg-muted rounded w-1/3 mb-2"></div>
                        <div className="h-3 bg-muted rounded w-1/2"></div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : chatRooms.length === 0 ? (
                <div className="text-center py-12">
                  <User className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium text-foreground mb-2">No conversations yet</h3>
                  <p className="text-muted-foreground">When an employer on Recrutas replies to your application, the conversation shows up here.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {chatRooms.map((room: any) => {
                    const otherUser = session.user?.user_metadata?.role === 'candidate' ? room.match?.recruiter : room.match?.candidate;
                    const jobTitle = room.match?.job?.title || 'Job';

                    if (!otherUser) {return null;}

                    return (
                      <Button
                        key={room.id}
                        variant="ghost"
                        className="w-full justify-start p-4 h-auto"
                        onClick={() => setLocation(`/chat/${room.id}`)}
                      >
                        <Avatar className="h-10 w-10">
                          <AvatarImage src={otherUser.profileImageUrl} />
                          <AvatarFallback>
                            {(otherUser.firstName?.[0] || otherUser.email?.[0] || 'U').toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="ml-3 text-left flex-1">
                          <p className="font-medium">
                            {otherUser.firstName || otherUser.email?.split('@')[0] || 'User'}
                          </p>
                          <p className="text-sm text-muted-foreground">{jobTitle}</p>
                        </div>
                      </Button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Show specific chat room
  const currentRoom = chatRooms.find((room: any) => room.id.toString() === roomId);
  if (!currentRoom) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Chat room not found</p>
      </div>
    );
  }

  return <ChatInterface roomId={parseInt(roomId)} room={currentRoom} />;
}
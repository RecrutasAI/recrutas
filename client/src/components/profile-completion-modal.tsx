import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X, Trash2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const profileSchema = z.object({
  bio: z.string().min(10, "Bio must be at least 10 characters"),
  location: z.string().min(2, "Location is required"),
  experience: z.enum(["entry", "mid", "senior", "executive"]),
  skills: z.array(z.string()).min(3, "Add at least 3 skills"),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  githubUrl: z.string().url().optional().or(z.literal("")),
  portfolioUrl: z.string().url().optional().or(z.literal("")),
});

type ProfileFormData = z.infer<typeof profileSchema>;

interface ProfileCompletionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentProfile?: any;
}

export function ProfileCompletionModal({ 
  open, 
  onOpenChange, 
  currentProfile 
}: ProfileCompletionModalProps) {
  const { toast } = useToast();
  const [skillInput, setSkillInput] = useState("");

  const form = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      bio: currentProfile?.bio || "",
      location: currentProfile?.location || "",
      experience: currentProfile?.experience || "entry",
      skills: currentProfile?.skills || [],
      linkedinUrl: currentProfile?.linkedinUrl || "",
      githubUrl: currentProfile?.githubUrl || "",
      portfolioUrl: currentProfile?.portfolioUrl || "",
    },
  });

  // Sync form when currentProfile loads or changes (defaultValues only apply on mount)
  useEffect(() => {
    if (currentProfile) {
      form.reset({
        bio: currentProfile.bio || "",
        location: currentProfile.location || "",
        experience: currentProfile.experience || "entry",
        skills: currentProfile.skills || [],
        linkedinUrl: currentProfile.linkedinUrl || "",
        githubUrl: currentProfile.githubUrl || "",
        portfolioUrl: currentProfile.portfolioUrl || "",
      });
    }
  }, [currentProfile, form]);

  const updateProfileMutation = useMutation({
    mutationFn: async (data: ProfileFormData) => {
      const response = await apiRequest("POST", "/api/candidate/profile", data);
      if (!response.ok) {
        throw new Error("Failed to update profile");
      }
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Profile Updated",
        description: "Your profile has been completed successfully!",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/candidate/profile"] });
      onOpenChange(false);
    },
    onError: () => {
      toast({
        title: "Update Failed",
        description: "Failed to update profile. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (data: ProfileFormData) => {
    updateProfileMutation.mutate(data);
  };

  const addSkill = () => {
    if (skillInput.trim() && !form.getValues("skills").includes(skillInput.trim())) {
      const currentSkills = form.getValues("skills");
      form.setValue("skills", [...currentSkills, skillInput.trim()]);
      setSkillInput("");
    }
  };

  const removeSkill = (skillToRemove: string) => {
    const currentSkills = form.getValues("skills");
    form.setValue("skills", currentSkills.filter(skill => skill !== skillToRemove));
  };

  const clearAllSkills = () => {
    form.setValue("skills", []);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addSkill();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <div className="px-6 pt-6 pb-2">
          <DialogHeader>
            <DialogTitle className="text-lg">Complete Your Profile</DialogTitle>
          </DialogHeader>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)}>
            <div className="px-6 space-y-5 max-h-[60vh] overflow-y-auto">
              <FormField
                control={form.control}
                name="bio"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Professional Bio</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Tell us about your professional background and career goals..."
                        className="min-h-[100px] rounded-xl"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="location"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Location</FormLabel>
                      <FormControl>
                        <Input placeholder="San Francisco, CA" className="rounded-xl" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="experience"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Experience Level</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="rounded-xl">
                            <SelectValue placeholder="Select level" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="entry">Entry Level (0-2 years)</SelectItem>
                          <SelectItem value="mid">Mid Level (3-5 years)</SelectItem>
                          <SelectItem value="senior">Senior Level (6+ years)</SelectItem>
                          <SelectItem value="executive">Executive Level</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="skills"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel>Skills</FormLabel>
                      {field.value.length > 0 && (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="h-8 px-3 gap-1.5 bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500 shadow-sm"
                          aria-label="Clear all skills"
                          onClick={clearAllSkills}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          Clear all
                        </Button>
                      )}
                    </div>
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <Input
                          placeholder="Add a skill..."
                          className="rounded-xl"
                          value={skillInput}
                          onChange={(e) => setSkillInput(e.target.value)}
                          onKeyPress={handleKeyPress}
                        />
                        <Button type="button" variant="outline" className="rounded-xl" onClick={addSkill} disabled={!skillInput.trim()}>
                          Add
                        </Button>
                      </div>
                      {field.value.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {field.value.map((skill) => (
                            <Badge key={skill} variant="secondary" className="flex items-center gap-1 rounded-lg px-2.5 py-1">
                              {skill}
                              <X
                                className="h-3 w-3 cursor-pointer opacity-60 hover:opacity-100"
                                onClick={() => removeSkill(skill)}
                              />
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="space-y-3">
                <h3 className="text-sm font-medium text-slate-500">Links (Optional)</h3>
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700 overflow-hidden">
                  <FormField
                    control={form.control}
                    name="linkedinUrl"
                    render={({ field }) => (
                      <FormItem className="px-4 py-3 space-y-1">
                        <FormLabel className="text-xs text-slate-500">LinkedIn</FormLabel>
                        <FormControl>
                          <Input placeholder="https://linkedin.com/in/yourprofile" className="border-0 p-0 h-8 shadow-none focus-visible:ring-0" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="githubUrl"
                    render={({ field }) => (
                      <FormItem className="px-4 py-3 space-y-1">
                        <FormLabel className="text-xs text-slate-500">GitHub</FormLabel>
                        <FormControl>
                          <Input placeholder="https://github.com/yourusername" className="border-0 p-0 h-8 shadow-none focus-visible:ring-0" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="portfolioUrl"
                    render={({ field }) => (
                      <FormItem className="px-4 py-3 space-y-1">
                        <FormLabel className="text-xs text-slate-500">Portfolio</FormLabel>
                        <FormControl>
                          <Input placeholder="https://yourportfolio.com" className="border-0 p-0 h-8 shadow-none focus-visible:ring-0" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 px-6 py-4 mt-2 border-t border-slate-200 dark:border-slate-700">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={updateProfileMutation.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {updateProfileMutation.isPending ? "Updating..." : "Save Profile"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
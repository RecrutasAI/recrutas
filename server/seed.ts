import dotenv from 'dotenv';
dotenv.config();

import { db } from "./db";
import { users, candidateProfiles, jobPostings, jobMatches, activityLogs, jobApplications } from "../shared/schema.js";
import { supabaseAdmin } from "./lib/supabase-admin";

export async function seedDatabase() {
  try {
    console.log("Seeding database with sample data...");
    console.log("DATABASE_URL in seed.ts:", process.env.DATABASE_URL);
    console.log("SUPABASE_URL in seed.ts:", process.env.NEXT_PUBLIC_SUPABASE_URL);
    console.log("SUPABASE_SERVICE_ROLE_KEY in seed.ts:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "*****" : "Not set");

    // Clear existing data
    await db.delete(jobApplications);
    await db.delete(jobMatches);
    await db.delete(jobPostings);
    await db.delete(candidateProfiles);
    await db.delete(activityLogs);
    // await db.delete(users);

    // Create a specific user from environment variables
    const seedEmail = process.env.SEED_USER_EMAIL;
    const seedPassword = process.env.SEED_USER_PASSWORD;

    if (!seedEmail || !seedPassword) {
      console.error('SEED_USER_EMAIL and SEED_USER_PASSWORD environment variables are required for seeding');
      return;
    }

    const { data: { user }, error } = await supabaseAdmin.auth.admin.createUser({
      email: seedEmail,
      password: seedPassword,
      email_confirm: true,
      user_metadata: { role: 'candidate' }
    });

    if (error) {
      console.error('Error creating user:', error.message);
      return;
    }

    if (!user) {
      console.error('User not created');
      return;
    }

    await db.insert(users).values({
      id: user.id,
      email: user.email,
      firstName: process.env.SEED_USER_FIRST_NAME || "Test",
      lastName: process.env.SEED_USER_LAST_NAME || "User",
      role: "candidate",
    });

    // Create candidate profile
    await db.insert(candidateProfiles).values({
      userId: user.id,
      skills: ["JavaScript", "React", "Node.js", "TypeScript", "PostgreSQL"],
      experience: "5 years of full-stack development experience",
      industry: "Technology",
      workType: "Remote",
      salaryMin: 90000,
      salaryMax: 130000,
      location: "San Francisco, CA",
      bio: "Passionate full-stack developer with expertise in modern web technologies",
    });

    // Create job postings
    await db.insert(jobPostings).values([
      {
        title: "Software Engineer",
        company: "Google",
        location: "Mountain View, CA",
        description: "Design, develop, test, deploy, maintain and improve software.",
        requirements: ["BS degree in Computer Science", "2 years of experience"],
        skills: ["C++", "Java", "Python"],
        workType: "Full-time",
        salaryMin: 120000,
        salaryMax: 180000,
        status: "active",
        talentOwnerId: user.id,
      },
      {
        title: "Frontend Developer",
        company: "Facebook",
        location: "Menlo Park, CA",
        description: "Build amazing user experiences.",
        requirements: ["BS degree in Computer Science", "Experience with React"],
        skills: ["JavaScript", "React", "HTML", "CSS"],
        workType: "Full-time",
        salaryMin: 110000,
        salaryMax: 170000,
        status: "active",
        talentOwnerId: user.id,
      },
      {
        title: "Data Scientist",
        company: "Netflix",
        location: "Los Gatos, CA",
        description: "Help shape the future of entertainment.",
        requirements: ["MS or PhD in a quantitative field", "Experience with machine learning"],
        skills: ["Python", "R", "SQL", "Machine Learning"],
        workType: "Full-time",
        salaryMin: 130000,
        salaryMax: 200000,
        status: "active",
        talentOwnerId: user.id,
      },
    ]);

    console.log("Database seeded successfully!");
  } catch (error) {
    console.error("Error seeding database:", error);
  }
}
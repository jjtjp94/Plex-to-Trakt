// Seed a test user for local webhook testing.
// Usage: npx tsx test/seedUser.mjs
import { prisma } from "../src/services/prisma.js"

const user = await prisma.user.upsert({
  where: { plexId: "999001" },
  update: {},
  create: {
    plexId: "999001",
    plexUsername: "testuser",
    plexEmail: "test@example.com",
    traktClientId: "test-client-id",
    traktClientSecret: "test-client-secret",
    traktAccessToken: "test-access-token",
    traktRefreshToken: "test-refresh-token",
    traktExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  },
})
console.log("Seeded user:", user.plexId, user.plexUsername)
await prisma.$disconnect()

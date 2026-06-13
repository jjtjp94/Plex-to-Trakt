# Node 22 is required by @prisma/streams-local (>=22.0.0)
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Build tools for native modules (better-sqlite3) if no prebuilt binary exists
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies (tsx is needed at runtime)
RUN npm install

# Remove build-only tools to keep the final image small
RUN apk del python3 make g++

# Copy application files
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Create directory for database
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Start script that pushes schema changes and then starts the app
CMD npx prisma db push && npm start

FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# NEXT_PUBLIC_* must be set at build time (Next.js inlines them into the bundle).
# NEXT_PUBLIC_USE_LOCAL_ENGINE defaults to "false" so forks don't ping the
# repo author's loca.lt tunnel when no local backend is configured. Set to
# "true" in your build args only if you're running the matching local backend
# and pointing NEXT_PUBLIC_API_URL at it.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_USE_LOCAL_ENGINE=false
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_USE_LOCAL_ENGINE=$NEXT_PUBLIC_USE_LOCAL_ENGINE

# Build the Next.js application
RUN npm run build

# Expose port 3000 (default Next.js port inside container)
EXPOSE 3000

# Start the application
CMD ["npm", "start"]

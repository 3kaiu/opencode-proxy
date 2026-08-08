FROM denoland/deno:2.0.0
WORKDIR /app
COPY supabase/functions/proxy/index.js .
EXPOSE 8080
CMD ["run", "--allow-net", "index.js"]

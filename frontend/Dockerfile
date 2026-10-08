ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:stable-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY --from=rdf_ui_messages / /shared/
COPY dev ./dev
COPY public ./public
RUN umask 077 && npm run build

FROM ${NGINX_IMAGE}
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Release archives can be extracted with umask 077. Only public static files
# are made readable by the Nginx worker; TLS keys are mounted separately.
RUN chmod -R a+rX /usr/share/nginx/html
USER nginx
RUN test -r /usr/share/nginx/html/index.html \
    && test -x /usr/share/nginx/html/assets \
    && for asset in /usr/share/nginx/html/assets/*.js /usr/share/nginx/html/assets/*.css; do \
         test -r "$asset" || exit 1; \
       done
USER root
EXPOSE 80 443

FROM public.ecr.aws/docker/library/node:24-alpine@sha256:333f6b3eca25980d5682c26207665b93c9417786b21760b2764d5821d9704c8a
WORKDIR /app
COPY server.cjs package.json LICENSE-BISCA.txt THIRD_PARTY_NOTICES.md ./
COPY engines ./engines
COPY public ./public
ENV PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.cjs"]

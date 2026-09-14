# 来源与整合说明

## 实际使用的上游代码

项目：https://github.com/29-Cu/bisca
作者：Cu & Lunedì
许可：Creative Commons Attribution 4.0 International（CC BY 4.0）
完整许可随包保存在 LICENSE-BISCA.txt；许可链接：https://creativecommons.org/licenses/by/4.0/

使用文件：
- cards/engines/zjh.cjs → engines/zjh.cjs
- cards/test/zjh.test.cjs → test/zjh.test.cjs

2026-09-14 的本地修改：
- 最大人数从 4 人扩展到 8 人，并修改人数边界测试。
- 服务端实际对局使用 node:crypto.randomInt 洗牌和定庄；保留原有确定性模式供测试使用。
- 新建单进程 HTTP 服务、入场密码、独立浏览器座位认证、房主权限、版本冲突与重复动作检查。
- 新建手机/电脑界面、多房间大厅、邀请链接、聊天、计分、超时弃牌和群晖部署配置。
- 保留原作者署名。本整合版新增应用代码也按 CC BY 4.0 提供，且不暗示原作者认可本版本。

## 调研参考，未复制代码

- https://github.com/dixilin/zjh-frontend
- https://github.com/dixilin/zjh-backend
  参考多房间、最多 8 人、首轮限制比牌的使用方式。仓库未见明确许可证，不复制其源码。
- https://github.com/luyao618/golden-flower
  参考清晰的牌桌动作与对局反馈。用户只需真人联机，因此不引入其大模型后端或 API 依赖。
- https://github.com/floatinghotpot/casino-server
  参考服务端判定、实时联机的架构思路。本版无需 Redis 和 Socket.IO，也未复制该项目代码。

这不是四套项目机械拼接：实际派生基础是 Bisca 的炸金花引擎，其余所需功能自行实现。

## 容器基础镜像

来源：Docker Official Image Node，使用 Amazon ECR Public 的 docker/library/node 镜像分发。
索引标签：24-alpine；平台：linux/amd64。
所用平台清单：sha256:333f6b3eca25980d5682c26207665b93c9417786b21760b2764d5821d9704c8a
上游源代码：https://github.com/nodejs/docker-node
上游镜像：https://hub.docker.com/_/node
基础系统和运行时内含各自许可，不受本应用 CC BY 4.0 许可替代。

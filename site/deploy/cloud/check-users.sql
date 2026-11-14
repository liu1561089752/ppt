-- 运维查询:列出用户与口令变更时间(排查"改密后会话失效/是谁改的")
-- 用法(服务器):sudo -u chatppt sqlite3 /home/chatppt/data/custom.db < deploy/cloud/check-users.sql
SELECT username,
       isAdmin,
       isActive,
       datetime(passwordChangedAt / 1000, 'unixepoch', '+8 hours') AS pwd_changed
FROM User
ORDER BY isAdmin DESC, username;

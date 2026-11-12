-- Reverts 002. This drops every expiry date and the flag: the links themselves stay.
DROP TABLE flags;
ALTER TABLE links DROP COLUMN expires_at;

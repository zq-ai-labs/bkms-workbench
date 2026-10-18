# -*- coding: utf-8 -*-
"""bridge.py 的纯函数测试：python -m unittest wechat/test_bridge.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import bridge  # noqa: E402


class RenderTest(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(bridge.kind_of("wxid_a"), "person")
        self.assertEqual(bridge.kind_of("abc@openim"), "person")
        self.assertEqual(bridge.kind_of("1@chatroom"), "group")
        self.assertEqual(bridge.kind_of("gh_x"), "official")
        for u in ("filehelper", "weixin", "@placeholder_foldgroup", ""):
            self.assertEqual(bridge.kind_of(u), "system")

    def test_appmsg_variants(self):
        link = '<msg><appmsg><title>年度报告</title><type>5</type><url>http://x</url></appmsg></msg>'
        self.assertEqual(bridge.render("文件/链接/卡片", link), ("[链接] 年度报告", None))
        self.assertEqual(bridge.render("文件/链接/卡片", "junk\x01<msg><appmsg><type>2000</type></appmsg></msg>")[0], "[转账]")
        self.assertEqual(bridge.render("文件/链接/卡片", "not xml")[0], "[分享]")
        escaped = '&lt;msg&gt;&lt;appmsg&gt;&lt;title&gt;合同.docx&lt;/title&gt;&lt;type&gt;6&lt;/type&gt;&lt;/appmsg&gt;&lt;/msg&gt;'
        self.assertEqual(bridge.render("文件/链接/卡片", escaped)[0], "[文件] 合同.docx")

    def test_quote_of_a_quote_keeps_only_title(self):
        inner = '&lt;msg&gt;&lt;appmsg&gt;&lt;title&gt;原话&lt;/title&gt;&lt;type&gt;57&lt;/type&gt;&lt;/appmsg&gt;&lt;/msg&gt;'
        xml = '<msg><appmsg><title>回复</title><type>57</type><refermsg><displayname>甲</displayname><content>%s</content></refermsg></appmsg></msg>' % inner
        text, quote = bridge.render("文件/链接/卡片", xml)
        self.assertEqual(text, "回复")
        self.assertEqual(quote, {"sender": "甲", "text": "原话"})

    def test_media_placeholders(self):
        for t, v in (("图片", "[图片]"), ("语音", "[语音]"), ("动画表情", "[表情]"), (12345, "[消息]")):
            self.assertEqual(bridge.render(t, "<x/>")[0], v)

    def test_mentions(self):
        self.assertTrue(bridge.mentions("<atuserlist><![CDATA[a,wxid_me]]></atuserlist>", "wxid_me"))
        self.assertTrue(bridge.mentions("<atuserlist>notify@all</atuserlist>", "wxid_me"))
        self.assertFalse(bridge.mentions("<atuserlist><![CDATA[a]]></atuserlist>", "wxid_me"))
        self.assertFalse(bridge.mentions("", "wxid_me"))

    def test_normalize_group_prefix_and_self(self):
        row = {"sort_seq": 5, "create_time": 0, "type": "文本", "sender_username": "", "content": "wxid_me:\n好的"}
        out = bridge.normalize(row, "1@chatroom", "wxid_me", ["赵"], {})
        self.assertTrue(out["self"])
        self.assertEqual(out["text"], "好的")
        self.assertNotIn("mentionsMe", out)
        private = bridge.normalize({"sort_seq": 6, "type": "文本", "sender_username": "", "content": "a:\nb"}, "wxid_x", "wxid_me", ["赵"], {})
        self.assertEqual(private["sender"], "wxid_x")
        self.assertEqual(private["text"], "a:\nb", "private chats never strip a prefix")

    def test_mention_by_name_or_quote(self):
        row = {"sort_seq": 1, "type": "文本", "sender_username": "u1", "content": "@赵 看下"}
        self.assertTrue(bridge.normalize(row, "1@chatroom", "wxid_me", ["赵"], {})["mentionsMe"])
        quote = '<msg><appmsg><title>好</title><type>57</type><refermsg><displayname>赵</displayname><content>x</content></refermsg></appmsg></msg>'
        row = {"sort_seq": 2, "type": "文件/链接/卡片", "sender_username": "u1", "content": quote}
        self.assertTrue(bridge.normalize(row, "1@chatroom", "wxid_me", ["赵"], {})["mentionsMe"])


if __name__ == "__main__":
    unittest.main()

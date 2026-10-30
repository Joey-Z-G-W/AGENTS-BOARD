"""Bounded synthetic child-agent fixtures; no native user sessions are read."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from probe_test import scope


class SubagentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.folder = self.home / '.codex/sessions'
        self.folder.mkdir(parents=True)
        self.state = None
        for context in (patch.dict(os.environ, {'CODEX_HOME': str(self.home/'.codex'), 'APPDATA':str(self.home/'empty')}),
                        patch.object(Path,'home',return_value=self.home), patch.dict(scope, {'enrich_git':lambda *_:None})):
            context.start()
            self.addCleanup(context.stop)

    def rows(self, native, parent=None, completed=True):
        source = {'subagent':{'thread_spawn':{'parent_thread_id':parent, 'agent_nickname':'Ada', 'agent_path':'/root/swe', 'agent_role':None}}} if parent else 'cli'
        rows = [{'type':'session_meta','payload':{'id':native,'source':source,'cwd':'/same-directory'}},
                {'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':'INHERITED SECRET'}]}},
                {'type':'event_msg','timestamp':'2026-10-24T01:00:00Z','payload':{'type':'task_started','turn_id':'turn-1'}},
                {'type':'turn_context','timestamp':'2026-10-24T01:00:01Z','payload':{'turn_id':'turn-1','model':'actual-model','effort':'high'}},
                {'type':'event_msg','timestamp':'2026-10-24T01:00:02Z','payload':{'type':'user_message','message':'child request' if parent else 'parent request','turn_id':'turn-1'}}]
        if completed:
            rows.append({'type':'event_msg','timestamp':'2026-10-24T01:00:03Z','payload':{'type':'task_complete','turn_id':'turn-1','last_agent_message':'result'}})
        return rows

    def write(self, filename, rows):
        path=self.folder/filename
        path.write_text(''.join(json.dumps(row)+'\n' for row in rows),encoding='utf-8')
        return path

    def run_probe(self, **kwargs):
        result=scope['run_request']({'version':1,'includeSubagents':True,'state':self.state,**kwargs})
        self.state=result['state']
        return result

    def parent(self,result):
        return next(row['session'] for row in result['records'] if row['session']['nativeId']=='p')

    def test_direct_relationship_deduplicates_without_main_cards_or_grandchildren(self):
        self.write('p.jsonl',self.rows('p',completed=False))
        self.write('c.jsonl',self.rows('c','p'))
        self.write('duplicate.jsonl',self.rows('c','p'))
        self.write('grandchild.jsonl',self.rows('g','c'))
        self.write('orphan.jsonl',self.rows('o','absent'))
        result=self.run_probe()
        self.assertEqual(len(result['records']),1)
        parent=self.parent(result)
        self.assertEqual(parent['status'],'unknown')
        self.assertEqual(parent['subagents']['status'],'complete')
        self.assertEqual(len(parent['subagents']['items']),1)
        child=parent['subagents']['items'][0]
        self.assertEqual((child['model'],child['effort'],child['status']),('actual-model','high','completed'))
        self.assertIsNone(child['role'])
        self.assertEqual(child['prompt'],'child request')
        self.assertNotIn('INHERITED SECRET',json.dumps(parent))

    def test_child_first_parent_later_and_parent_directed_read_is_isolated(self):
        self.write('c.jsonl',self.rows('c','p'))
        self.assertEqual(self.run_probe()['records'],[])
        self.write('p.jsonl',self.rows('p'))
        result=self.run_probe()
        child=self.parent(result)['subagents']['items'][0]
        published=copy.deepcopy(self.state['codex'][str(self.folder/'c.jsonl')]['publishedSubagent'])
        result=self.run_probe(target=result['records'][0]['locator'])
        self.assertEqual(len(result['records']),1)
        self.assertNotIn('subagents',result['records'][0]['session'])
        self.assertEqual(self.state['codex'][str(self.folder/'c.jsonl')]['publishedSubagent'],published)
        self.assertEqual(child,published)

    def test_reuse_resets_runtime_and_completion_and_ignores_wrong_context(self):
        path=self.write('c.jsonl',self.rows('c','p'))
        self.write('p.jsonl',self.rows('p'))
        self.run_probe()
        with path.open('a',encoding='utf-8') as stream:
            for row in [{'type':'event_msg','payload':{'type':'task_started','turn_id':'turn-2'}},
                        {'type':'turn_context','payload':{'turn_id':'turn-1','model':'wrong','effort':'low'}}]:
                stream.write(json.dumps(row)+'\n')
        child=self.parent(self.run_probe())['subagents']['items'][0]
        self.assertEqual(child['turnId'],'turn-2')
        self.assertEqual(child['status'],'unknown')
        self.assertIsNone(child['model'])
        self.assertIsNone(child['effort'])
        self.assertIsNone(child['response'])
        with path.open('a',encoding='utf-8') as stream:
            stream.write(json.dumps({'type':'event_msg','payload':{'type':'turn_aborted','turn_id':'turn-2'}})+'\n')
        self.assertEqual(self.parent(self.run_probe())['subagents']['items'][0]['status'],'interrupted')

    def test_failed_or_partial_read_keeps_original_child_collection_time(self):
        path=self.write('c.jsonl',self.rows('c','p'))
        self.write('p.jsonl',self.rows('p'))
        first=self.parent(self.run_probe())['subagents']['items'][0]
        with path.open('ab') as stream: stream.write(b'{"unfinished":')
        collection=self.parent(self.run_probe())['subagents']
        self.assertEqual(collection['status'],'partial')
        self.assertEqual(collection['items'][0],first)
        path.unlink()
        collection=self.parent(self.run_probe())['subagents']
        self.assertEqual(collection['status'],'error')
        self.assertEqual(collection['items'][0],first)

    def test_empty_complete_partial_budget_and_remote_opt_out(self):
        self.write('p.jsonl',self.rows('p'))
        self.assertEqual(self.parent(self.run_probe())['subagents']['items'],[])
        self.write('c.jsonl',self.rows('c','p'))
        with patch.dict(scope,{'MAX_TRACKED':1}):
            result=self.run_probe()
        self.assertTrue(result['state']['codexLimited'])
        self.assertLessEqual(len(result['state']['codex']),1)
        result=self.run_probe(includeSubagents=False)
        for row in result['records']:
            self.assertNotIn('subagents',row['session'])
            self.assertNotEqual(row['session']['source'],'codex_subagent')

    def test_invalid_or_self_parent_never_becomes_top_level(self):
        for native,parent in [('self','self'),('empty',''),('bad',123)]:
            rows=self.rows(native,'p')
            rows[0]['payload']['source']['subagent']['thread_spawn']['parent_thread_id']=parent
            self.write(native+'.jsonl',rows)
        self.assertEqual(self.run_probe()['records'],[])


if __name__=='__main__': unittest.main()

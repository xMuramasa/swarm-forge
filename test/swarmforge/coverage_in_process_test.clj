(ns swarmforge.coverage-in-process-test
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [crap]
            [handoff-lib]
            [herdr]
            [swarm-handoff]
            [swarm-tool]
            [swarmforge]))

(defn- tmp-dir []
  (fs/create-temp-dir {:prefix "swarmforge-in-process-test."}))

(deftest herdr-agent-names-fit-herdr-rules
  (is (= "sf-my-project-qa" (herdr/agent-name "/x/My Project" "QA")))
  (let [name (herdr/agent-name "/x/a-very-long-project-directory-name" "specifier")]
    (is (<= (count name) 32))
    (is (re-matches #"[a-z][a-z0-9_-]{0,31}" name)))
  (is (thrown? Exception (herdr/agent-name "/x/p" (apply str (repeat 40 "r"))))))

(def lizard-csv
  (str "13,5,60,1,14,\"classify@1-14@src/c.ts\",\"src/c.ts\",\"classify\",\"classify ( n )\",1,14\n"
       "3,1,18,2,3,\"add@14-16@src/c.ts\",\"src/c.ts\",\"add\",\"add ( a , b )\",14,16\n"))

(deftest crap-scores-each-function-from-lizard-and-lcov
  ;; classify: half its executable lines ran -> 5^2 * 0.5^3 + 5; add: fully covered -> its CCN
  (let [coverage (crap/parse-lcov "TN:\nSF:src/c.ts\nDA:2,2\nDA:3,1\nDA:6,0\nDA:7,0\nDA:15,1\nend_of_record\n")
        [worst best] (crap/evaluate (crap/parse-lizard-csv lizard-csv) coverage)]
    (is (= "classify" (:name worst)))
    (is (< (Math/abs (- 8.125 (:crap worst))) 1e-9))
    (is (= "add" (:name best)))
    (is (= 1.0 (:crap best)))))

(deftest crap-treats-unloaded-files-as-uncovered-and-declarations-as-covered
  (let [f {:file (crap/normalize "src/c.ts") :start 1 :end 5 :ccn 3}]
    (is (= 0.0 (crap/function-coverage {} f)))
    (is (= 12.0 (crap/crap-score 3 0.0)))
    (is (= 1.0 (crap/function-coverage {(crap/normalize "src/c.ts") {50 1}} f)))))

(deftest herdr-grid-plan-tiles-roles-in-two-rows
  (is (= [] (herdr/grid-plan 1)))
  (is (= [[0 "right" 0.5]] (herdr/grid-plan 2)))
  (is (= [[0 "right" 0.5] [0 "down" 0.5]] (herdr/grid-plan 3)))
  (is (= [[0 "right" 0.5] [0 "down" 0.5] [1 "down" 0.5]] (herdr/grid-plan 4)))
  ;; three columns: each split keeps 1/3 then 1/2 of what remains, so widths are equal
  (is (= [[0 "right" (/ 1.0 3)] [1 "right" 0.5] [0 "down" 0.5] [1 "down" 0.5] [2 "down" 0.5]]
         (herdr/grid-plan 6))))

(deftest handoff-lib-validates-priority-and-headers
  (is (handoff-lib/valid-priority? "10"))
  (is (not (handoff-lib/valid-priority? "5")))
  (let [root (tmp-dir)
        file (fs/path root "task.handoff")]
    (try
      (spit (str file) "task: alpha\nfrom: coder\n\nbody\n")
      (is (= "alpha" (handoff-lib/header-field file "task")))
      (is (= "body\n" (handoff-lib/body file)))
      (finally
        (fs/delete-tree root)))))

(deftest swarm-handoff-parses-note-draft
  (let [root (tmp-dir)
        draft (fs/path root "note.handoff")]
    (try
      (spit (str draft) "type: note\nto: cleaner\npriority: 50\nmessage: hello\n")
      (let [{:keys [headers errors]} (swarm-handoff/parse-draft draft)]
        (is (empty? errors))
        (is (= "note" (get headers "type")))
        (is (= "cleaner" (get headers "to")))
        (is (= "hello" (get headers "message"))))
      (finally
        (fs/delete-tree root)))))

(deftest handoff-lib-rewrites-headers
  (is (= ["task: beta" "" "body"]
         (vec (handoff-lib/set-header-lines ["task: alpha" "" "body"] "task" "beta"))))
  (is (= ["task: alpha" "from: coder"]
         (vec (handoff-lib/append-header ["task: alpha"] "from: " "coder"))))
  (let [root (tmp-dir)
        file (fs/path root "item.handoff")]
    (try
      (spit (str file) "task: alpha\n\nbody\n")
      (handoff-lib/set-header! file "task" "beta")
      (is (re-find #"task: beta" (slurp (str file))))
      (handoff-lib/print-task file)
      (is (not (handoff-lib/roles-at? nil)))
      (is (handoff-lib/same-path? "/tmp" "/tmp"))
      (finally
        (fs/delete-tree root)))))

(defn- git-command [disambiguate-out object-type short-out]
  (fn [_dir & args]
    (cond
      (some #(str/starts-with? % "--disambiguate=") args)
      {:exit 0 :out disambiguate-out}
      (= ["git" "cat-file" "-t"] (take 3 args))
      {:exit 0 :out object-type}
      (some #(= "--short=10" %) args)
      {:exit 0 :out short-out}
      :else {:exit 1 :out "" :err "unexpected git"})))

(defn- with-validate-mocks [{:keys [known? command]} f]
  (with-redefs [swarm-handoff/git-cwd (constantly ".")
                swarm-handoff/role-known? (or known? (constantly true))
                swarm-handoff/command (or command (git-command "abcdef1234\n" "commit\n" "abcdef1234\n"))]
    (f)))

(defn- has-error? [result re]
  (boolean (some #(re-find re %) (:errors result))))

(deftest swarm-handoff-validates-headers
  (is (= [[] []] (swarm-handoff/validate-recipients "")))
  (is (= [] (swarm-handoff/current-work-state-errors {"type" "note"})))
  (is (= [] (swarm-handoff/task-state-errors {"type" "note"} "coder")))
  (let [root (tmp-dir)
        draft (fs/path root "bad.handoff")]
    (try
      (spit (str draft) "type: note\ntype: note\npriority: 50\nto: x\nmessage: hi\n")
      (is (seq (:errors (swarm-handoff/parse-draft draft))))
      (finally
        (fs/delete-tree root))))
  (with-validate-mocks {}
    (fn []
      (let [ok (swarm-handoff/validate
                {"type" "note" "to" "receiver" "priority" "50" "message" "hello"}
                ["type" "to" "priority" "message"])]
        (is (empty? (:errors ok)))
        (is (= ["receiver"] (:recipients ok)))
        (is (nil? (:canonical-commit ok))))
      (let [missing (swarm-handoff/validate {} [])]
        (is (has-error? missing #"Missing required header 'type'"))
        (is (has-error? missing #"Missing required header 'to'"))
        (is (has-error? missing #"Missing required header 'priority'")))
      (let [bad-type (swarm-handoff/validate
                      {"type" "fax" "to" "receiver" "priority" "50"}
                      ["type" "to" "priority"])]
        (is (has-error? bad-type #"must be one of git_handoff or note")))
      (let [bad-priority (swarm-handoff/validate
                          {"type" "note" "to" "receiver" "priority" "zz" "message" "hi"}
                          ["type" "to" "priority" "message"])]
        (is (has-error? bad-priority #"two digits from 00 to 99")))
      (let [illegal (swarm-handoff/validate
                     {"type" "note" "to" "receiver" "priority" "50" "message" "hi" "commit" "abcdef1234" "task" "nope"}
                     ["type" "to" "priority" "message" "commit" "task"])]
        (is (has-error? illegal #"Header 'commit' is not allowed for type 'note'"))
        (is (has-error? illegal #"Header 'task' is not allowed for type 'note'"))
        (is (has-error? illegal #"Header 'commit' is only allowed for git_handoff"))
        (is (has-error? illegal #"Header 'task' is only allowed for git_handoff")))
      (let [note-msg (swarm-handoff/validate
                      {"type" "note" "to" "receiver" "priority" "50"}
                      ["type" "to" "priority"])]
        (is (has-error? note-msg #"Missing required header 'message'")))
      (let [long-note (swarm-handoff/validate
                       {"type" "note" "to" "receiver" "priority" "50"
                        "message" (apply str (repeat 81 "x"))}
                       ["type" "to" "priority" "message"])]
        (is (has-error? long-note #"Header 'message' must be no longer than 80")))
      (let [git-msg (swarm-handoff/validate
                     {"type" "git_handoff" "to" "receiver" "priority" "50"
                      "task_id" "t1" "task" "t1" "commit" "abcdef1234" "message" "nope"}
                     ["type" "to" "priority" "task_id" "task" "commit" "message"])]
        (is (has-error? git-msg #"Header 'message' is not allowed for type 'git_handoff'"))
        (is (has-error? git-msg #"Header 'message' is only allowed for note")))
      (let [git-missing (swarm-handoff/validate
                         {"type" "git_handoff" "to" "receiver" "priority" "50"}
                         ["type" "to" "priority"])]
        (is (has-error? git-missing #"Missing required header 'commit'"))
        (is (has-error? git-missing #"Missing required header 'task_id'"))
        (is (has-error? git-missing #"Missing required header 'task'")))
      (let [bad-sha (swarm-handoff/validate
                     {"type" "git_handoff" "to" "receiver" "priority" "50"
                      "task_id" "t1" "task" "t1" "commit" "not-a-sha!"}
                     ["type" "to" "priority" "task_id" "task" "commit"])]
        (is (has-error? bad-sha #"exactly 10 hexadecimal characters")))
      (let [long-task (swarm-handoff/validate
                       {"type" "git_handoff" "to" "receiver" "priority" "50"
                        "task_id" "t1" "task" (apply str (repeat 81 "t")) "commit" "abcdef1234"}
                       ["type" "to" "priority" "task_id" "task" "commit"])]
        (is (has-error? long-task #"Header 'task' must be no longer than 80")))
      (let [ok-git (swarm-handoff/validate
                    {"type" "git_handoff" "to" "receiver" "priority" "50"
                     "task_id" "t1" "task" "t1" "commit" "abcdef1234"}
                    ["type" "to" "priority" "task_id" "task" "commit"])]
        (is (empty? (:errors ok-git)))
        (is (= "abcdef1234" (:canonical-commit ok-git))))))
  (with-validate-mocks {:command (git-command "aaa\nbbb\n" "commit\n" "aaa\n")}
    (fn []
      (let [result (swarm-handoff/validate
                    {"type" "git_handoff" "to" "receiver" "priority" "50"
                     "task_id" "t1" "task" "t1" "commit" "abcdef1234"}
                    ["type" "to" "priority" "task_id" "task" "commit"])]
        (is (has-error? result #"must resolve to exactly one Git object")))))
  (with-validate-mocks {:command (git-command "abcdef1234\n" "blob\n" "abcdef1234\n")}
    (fn []
      (let [result (swarm-handoff/validate
                    {"type" "git_handoff" "to" "receiver" "priority" "50"
                     "task_id" "t1" "task" "t1" "commit" "abcdef1234"}
                    ["type" "to" "priority" "task_id" "task" "commit"])]
        (is (has-error? result #"must resolve to a commit")))))
  (with-validate-mocks {:known? (constantly false)}
    (fn []
      (let [result (swarm-handoff/validate
                    {"type" "note" "to" "ghost" "priority" "50" "message" "hi"}
                    ["type" "to" "priority" "message"])]
        (is (has-error? result #"Unknown recipient role 'ghost'")))))
  (let [[_ errors] (with-validate-mocks {:known? (constantly true)}
                     (fn [] (swarm-handoff/validate-recipients "receiver,,receiver,bad_role")))]
    (is (some #(re-find #"empty recipient" %) errors))
    (is (some #(re-find #"underscores" %) errors))
    (is (some #(re-find #"Duplicate recipient 'receiver'" %) errors))))

(deftest swarm-tool-usage
  (is (fn? swarm-tool/-main)))

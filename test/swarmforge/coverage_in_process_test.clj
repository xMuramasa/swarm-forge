(ns swarmforge.coverage-in-process-test
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [herdr]
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

(deftest herdr-grid-plan-tiles-roles-in-two-rows
  (is (= [] (herdr/grid-plan 1)))
  (is (= [[0 "right" 0.5]] (herdr/grid-plan 2)))
  (is (= [[0 "right" 0.5] [0 "down" 0.5]] (herdr/grid-plan 3)))
  (is (= [[0 "right" 0.5] [0 "down" 0.5] [1 "down" 0.5]] (herdr/grid-plan 4)))
  ;; three columns: each split keeps 1/3 then 1/2 of what remains, so widths are equal
  (is (= [[0 "right" (/ 1.0 3)] [1 "right" 0.5] [0 "down" 0.5] [1 "down" 0.5] [2 "down" 0.5]]
         (herdr/grid-plan 6))))

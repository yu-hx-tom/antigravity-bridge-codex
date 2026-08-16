using System;
using System.Collections;
using System.Collections.Generic;
using System.Web.Script.Serialization;

class Program {
    static void Main() {
        string json = "{\"summary\": {\"groups\": [{\"displayName\": \"Gemini\", \"buckets\": [{\"bucketId\": \"gemini-weekly\", \"remainingFraction\": 0.74}]}]}}";
        JavaScriptSerializer js = new JavaScriptSerializer();
        var dict = js.Deserialize<Dictionary<string, object>>(json);
        var summary = dict["summary"] as Dictionary<string, object>;
        Console.WriteLine("summary != null: " + (summary != null));
        var groupsObj = summary["groups"];
        Console.WriteLine("groups type: " + groupsObj.GetType().FullName);
        Console.WriteLine("groups as ArrayList: " + ((groupsObj as ArrayList) != null));
        Console.WriteLine("groups as object[]: " + ((groupsObj as object[]) != null));
        Console.WriteLine("groups as IEnumerable: " + ((groupsObj as IEnumerable) != null));
    }
}

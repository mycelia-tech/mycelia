import { useMemo, useState } from "react";
import { ObjectId } from "bson";
import {
  SearchableSelectSingle,
  type SelectOption,
} from "@/components/ui/searchable-select-single";
import { Button } from "@/components/ui/button";
import {
  useCreateObject,
  useObject,
  useObjectSearch,
  useObjectSelection,
} from "@/hooks/useObjectQueries";
import type { Object } from "@/types/objects";

interface ObjectSelectionDropdownProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
}

const renderIcon = (icon: any) => {
  if (!icon) return "";
  if (typeof icon === "string") return icon;
  if (icon.text) return icon.text;
  if (icon.base64) return "📷";
  return "";
};

export function ObjectSelectionDropdown({
  value,
  onChange,
  placeholder = "Select an object...",
  label,
  className,
}: ObjectSelectionDropdownProps) {
  const createObjectMutation = useCreateObject();
  const [searchValue, setSearchValue] = useState("");

  // Fetch all objects for dropdown (1000 limit)
  const { data: allObjects = [] } = useObjectSelection();

  // Use search when user types, otherwise use all objects
  const { data: searchResults = [] } = useObjectSearch(
    searchValue.trim(),
    1000,
  );

  // Use search results if searching, otherwise use all objects
  const baseResults = searchValue.trim() ? searchResults : allObjects;

  // Fetch the selected object if it's not in the results
  const hasValueInResults = useMemo(() => {
    if (!value) return true;
    return baseResults.some((obj: Object) => {
      const objectIdString = obj._id instanceof ObjectId
        ? obj._id.toHexString()
        : String(obj._id);
      return objectIdString === value;
    });
  }, [baseResults, value]);

  const { data: selectedObject } = useObject(
    value && !hasValueInResults ? value : undefined,
  );

  const options: SelectOption[] = useMemo(() => {
    const objectOptions: SelectOption[] = baseResults.map((obj: Object) => {
      // Ensure consistent string representation of ObjectId
      const objectIdString = obj._id instanceof ObjectId
        ? obj._id.toHexString()
        : String(obj._id);

      const icon = renderIcon(obj.icon);
      const name = obj.name || "Unnamed";

      return {
        label: icon ? `${icon} ${name}` : name,
        value: objectIdString,
      };
    });

    // Add the selected object if it's not in the results
    if (selectedObject && value) {
      const objectIdString = selectedObject._id instanceof ObjectId
        ? selectedObject._id.toHexString()
        : String(selectedObject._id);

      // Only add if it's not already in the options
      if (!objectOptions.some((opt) => opt.value === objectIdString)) {
        const icon = renderIcon(selectedObject.icon);
        const name = selectedObject.name || "Unnamed";
        objectOptions.unshift({
          label: icon ? `${icon} ${name}` : name,
          value: objectIdString,
        });
      }
    }

    // Add create option if there's a search value and no exact match
    if (searchValue.trim()) {
      const hasExactMatch = objectOptions.some((option: SelectOption) =>
        option.label.toLowerCase() === searchValue.toLowerCase()
      );

      if (!hasExactMatch) {
        objectOptions.push({
          label: `➕ Create "${searchValue}"`,
          value: `__create__${searchValue}`,
        });
      }
    }

    return objectOptions;
  }, [baseResults, selectedObject, value, searchValue]);

  const handleCreateObject = async (objectName: string) => {
    if (!objectName.trim()) return;

    try {
      const result = await createObjectMutation.mutateAsync({
        name: objectName.trim(),
        icon: { text: "📦" }, // Default icon for new objects
        createdAt: new Date(),
      });

      // Update the form with the new object ID
      onChange(result.insertedId.toString());
    } catch (error) {
      console.error("Failed to create object:", error);
    }
  };

  const handleChange = (selectedValue: string) => {
    if (selectedValue.startsWith("__create__")) {
      const objectName = selectedValue.replace("__create__", "");
      handleCreateObject(objectName);
    } else {
      onChange(selectedValue);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearchValue(value);
  };

  const emptyIndicator = (searchValue: string) => {
    if (!searchValue.trim()) {
      return "No objects found";
    }

    return (
      <div className="flex items-center justify-between p-2">
        <span className="text-sm text-muted-foreground">
          No objects found for "{searchValue}"
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleCreateObject(searchValue)}
          className="ml-2"
        >
          Create "{searchValue}"
        </Button>
      </div>
    );
  };

  return (
    <div className={className}>
      {label && (
        <label className="text-sm font-medium text-foreground mb-2 block">
          {label}
        </label>
      )}
      <SearchableSelectSingle
        key={value}
        options={options}
        defaultValue={value}
        onValueChange={(value) => handleChange(value || "")}
        onSearchChange={handleSearchChange}
        placeholder={placeholder}
        searchable
        className="w-full"
        emptyIndicator={emptyIndicator}
      />
    </div>
  );
}
